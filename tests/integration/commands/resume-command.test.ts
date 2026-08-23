import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { type CommandContext, type Controls, tryHandleCommand } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  catalog: SessionCatalog;
  identity: SessionCatalogIdentity;
  run(
    content: string,
    options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' },
  ): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('OMP resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists the current catalog session through an opaque resume candidate', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'omp-session-current', now: 1_000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    const content = lastContent(h.channel);
    expect(JSON.stringify(content)).toContain('当前 OMP 会话');
    const candidates = resumeArgsFromCard(content.card);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toContain('omp-session-current');
  });

  it('applies a listed resume candidate and consumes the nonce', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'omp-session-current', now: 1_000 });
    await h.run('/resume');
    const [candidate] = resumeArgsFromCard(lastContent(h.channel).card);
    if (!candidate) throw new Error('missing resume candidate');

    await expect(h.run(`/resume use ${candidate}`)).resolves.toBe(true);
    expect(h.catalog.activeFor(h.identity)?.sessionId).toBe('omp-session-current');
    await expect(h.run(`/resume use ${candidate}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不可恢复');
  });

  it('does not accept a raw OMP session id', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'omp-session-current', now: 1_000 });
    await expect(h.run('/resume use omp-session-current')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不可恢复');
  });

  it('requires a catalog identity', async () => {
    const h = await createHarness();
    await expect(h.run('/resume', { withCatalogIdentity: false })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('没有可恢复的会话');
  });

  it('keeps resume details out of group chats', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'omp-session-current', now: 1_000 });
    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('群聊中不展示历史会话详情');
    expect(JSON.stringify(h.channel.sent)).not.toContain('omp-session-current');
  });

  it('requires a selected workspace', async () => {
    const h = await createHarness({ bindWorkspace: false, defaultWorkspace: false });
    await expect(h.run('/resume')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });
});

async function createHarness(
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('resume-command-omp-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const profileConfig = appConfig();
  if (options.defaultWorkspace !== false) profileConfig.workspaces.default = tmp.workspace;
  const controls = {
    profile: 'work',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) workspaces.setCwd('chat-1', tmp.workspace);
  const identity = await commandIdentity(profileConfig, controls, tmp.workspace);

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      scopedRuns: {
        activeMetadata: () => undefined,
        interrupt: (scope: string) => activeRuns.interrupt(scope),
        snapshot: () => ({
          activeScopes: activeRuns.scopes(),
          queue: { active: 0, waiting: 0, cap: 1 },
        }),
      } as never,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, catalog, identity, run };
}

async function commandIdentity(
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const policy = evaluateRunPolicy({
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou-user' },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canUseDm(profileConfig, controls, 'ou-user'),
    profileConfig,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(): ProfileConfig {
  return createDefaultProfileConfig({
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}
