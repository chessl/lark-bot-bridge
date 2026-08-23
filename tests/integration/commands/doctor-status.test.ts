import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import {
  type CommandContext,
  type Controls,
  tryHandleCommand,
} from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  FakeAgentAdapter,
  type FakeAgentEvents,
  type FakeAgentRun,
} from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
  agent: FakeAgentAdapter;
  controls: Controls;
  scopedRuns: ScopedRuns;
  run(content: string, chatMode?: 'p2p' | 'group' | 'topic'): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/status and /doctor diagnostics', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows passive status for active run, queue, and owner API state', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const activeRun = (await h.agent.start({
      runId: 'run-active',
      prompt: 'running',
    })) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);
    const release = await h.pool.acquire();

    await expect(h.run('/status')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(1);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('active run');
    expect(status).toContain('active scopes');
    expect(status).toContain('1/1 active');
    expect(status).toContain('owner API');
    expect(status).toContain('profile');
    expect(status).toContain('Oh My Pi');
    expect(status).toContain('access');
    expect(status).toContain('full');
  });

  it('runs only self-checks when no cwd is selected', async () => {
    const h = await createHarness({ configuredWorkspace: false, bindWorkspace: false });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('未设置工作目录');
    expect(lastMarkdownOrText(h.channel)).toContain('self-check');
  });

  it('allows an immediate retry after fixing an invalid workspace', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.workspaces.setCwd('chat-1', join(h.tmp.workspace, 'missing'));

    await expect(h.run('/doctor')).resolves.toBe(true);
    expect(h.agent.runOptions).toHaveLength(0);

    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    await expect(h.run('/doctor')).resolves.toBe(true);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('uses ScopedRuns for a sessionless read-only agent echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.sessionId).toBeUndefined();
    expect(opts.images).toEqual([]);
    expect(opts.prompt).toContain('OK');
    const output = lastMarkdownOrText(h.channel);
    expect(output).toContain('self-check');
    expect(output).toContain('profile');
    expect(output).toContain('Oh My Pi');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok access=full');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
  });

  it('lets final_text replace accumulated echo deltas', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      events: [
        { type: 'text', delta: 'partial' },
        { type: 'final_text', content: 'FINAL' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(lastMarkdownOrText(h.channel)).toContain('agent echo check: FINAL');
  });

  it('presents an interrupted diagnostic run as interrupted', async () => {
    const h = await createHarness({ configuredWorkspace: true, interrupt: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(lastMarkdownOrText(h.channel)).toContain('agent echo check: interrupted');
  });


  it('uses the profile default workspace when the chat has no bound cwd', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      bindWorkspace: false,
      defaultWorkspace: true,
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringContent(h.tmp.workspace));
    expect(status).not.toContain('工作目录已选择');
  });

  it('fast-fails the agent echo check when the process pool is full', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const release = await h.pool.acquire();

    await expect(h.run('/doctor')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('pool-full');
    expect(lastMarkdownOrText(h.channel)).toContain('policy check: ok access=full');
  });

  it('reports startup and non-capacity admission failures as failed', async () => {
    const startup = await createHarness({ configuredWorkspace: true, startupFailure: true });
    await expect(startup.run('/doctor')).resolves.toBe(true);
    expect(lastMarkdownOrText(startup.channel)).toContain('agent echo check: failed');
    expect(lastMarkdownOrText(startup.channel)).toContain('policy check: ok access=full');

    const duplicate = await createHarness({ configuredWorkspace: true });
    const active = await duplicate.scopedRuns.start({
      scopeId: 'chat-1:doctor',
      workspaceScopeId: 'chat-1',
      sessionScopeId: null,
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou-admin' },
      prompt: 'running',
      attachments: [],
      access: { ok: true, reason: 'allowed-admin' },
      nowait: true,
    });
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error('expected active diagnostic');

    await expect(duplicate.run('/doctor')).resolves.toBe(true);
    expect(lastMarkdownOrText(duplicate.channel)).toContain('agent echo check: failed');
    expect(lastMarkdownOrText(duplicate.channel)).toContain('policy check: ok access=full');
    await active.run.stop();
  });

  it.each(['group', 'topic'] as const)(
    'acknowledges %s diagnostics and sends the buffered result privately',
    async (chatMode) => {
      const h = await createHarness({ configuredWorkspace: true });

      await expect(h.run('/doctor', chatMode)).resolves.toBe(true);

      expect(h.channel.streams).toHaveLength(0);
      expect(h.channel.sent.map((message) => message.chatId)).toEqual(['chat-1', 'ou-admin']);
      expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('分析结果将私信发给你');
      expect(JSON.stringify(h.channel.sent[1]?.content)).toContain('agent echo check: OK');
    },
  );
});

async function createHarness(options: {
  configuredWorkspace: boolean;
  bindWorkspace?: boolean;
  defaultWorkspace?: boolean;
  startupFailure?: boolean;
  events?: FakeAgentEvents;
  interrupt?: boolean;
}): Promise<Harness> {
  const tmp = await createTmpProfile('doctor-status-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = options.startupFailure
    ? new ThrowingDoctorAgent()
    : options.interrupt
      ? new InterruptingDoctorAgent()
      : new FakeAgentAdapter({
          events: options.events ?? [
            [
              { type: 'text', delta: 'OK' },
              { type: 'done', terminationReason: 'normal' },
            ],
          ],
        });
  const profileConfig = appConfig(options.configuredWorkspace ? tmp.workspace : undefined);
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const scopedRuns = new ScopedRuns({
    agent,
    pool,
    activeRuns,
    workspaces,
    profile: 'claude',
    profileConfig: () => profileConfig,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });
  if (agent instanceof InterruptingDoctorAgent) {
    agent.interrupt = () => scopedRuns.interrupt('chat-1:doctor');
  }

  const run = (content: string, chatMode: 'p2p' | 'group' | 'topic' = 'p2p'): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, chatMode),
      scope: chatMode === 'topic' ? 'chat-1:thread-1' : 'chat-1',
      chatMode,
      sessions,
      workspaces,
      agent,
      scopedRuns,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    pool,
    agent,
    controls,
    scopedRuns,
    run,
  };
}

function appConfig(defaultWorkspace: string | undefined): ProfileConfig {
  const config = createDefaultProfileConfig({
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  if (defaultWorkspace) config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string, chatMode: 'p2p' | 'group' | 'topic' = 'p2p'): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: chatMode === 'p2p' ? 'p2p' : 'group',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: chatMode !== 'p2p',
    ...(chatMode === 'topic' ? { threadId: 'thread-1' } : {}),
  } as unknown as NormalizedMessage;
}

class ThrowingDoctorAgent extends FakeAgentAdapter {
  override async start(): Promise<never> {
    throw new Error('startup failed');
  }
}

class InterruptingDoctorAgent extends FakeAgentAdapter {
  interrupt: () => void = () => {};

  override async start(opts: AgentRunOptions): Promise<AgentRun> {
    const run = await super.start(opts);
    const interrupt = this.interrupt;
    return {
      runId: run.runId,
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', delta: 'partial' } as const;
          interrupt();
          yield { type: 'done', terminationReason: 'normal' } as const;
        },
      },
      stop: () => run.stop(),
      waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
    };
  }
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdownOrText(channel: FakeChannel): string {
  const content = lastContent(channel);
  const value = content.markdown ?? content.text;
  expect(value).toBeTypeOf('string');
  return value as string;
}


function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
