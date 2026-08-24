import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { type CommandContext, type Controls, tryHandleCommand } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTestScopedRuns } from '../../helpers/scoped-runs';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('saves /config submit into the active profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
    });

    const root = await waitForRoot(
      h.rootDir,
      (candidate) => candidate.profiles.claude?.preferences.maxConcurrentRuns === 7,
    );
    expect(root.schemaVersion).toBe(3);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('atomically saves a complete trusted peer directory', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit 2', {
      trusted_peer_alias_0: 'Hermes',
      trusted_peer_open_id_0: 'ou_peer1',
      trusted_peer_alias_1: 'Atlas',
      trusted_peer_open_id_1: 'ou_peer2',
    });

    const root = await waitForRoot(
      h.rootDir,
      (candidate) => candidate.profiles.claude?.collaboration.trustedPeerBots.length === 2,
    );
    expect(root.profiles.claude?.collaboration.trustedPeerBots).toEqual([
      { alias: 'Hermes', openId: 'ou_peer1' },
      { alias: 'Atlas', openId: 'ou_peer2' },
    ]);
  });

  it('writes nothing when any trusted peer row is invalid', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit 2', {
      max_concurrent_runs: '9',
      trusted_peer_alias_0: 'Hermes',
      trusted_peer_open_id_0: 'ou_peer1',
      trusted_peer_alias_1: 'hermes',
      trusted_peer_open_id_1: 'ou_peer2',
    });
    await vi.runAllTimersAsync();

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.collaboration.trustedPeerBots).toEqual([]);
    expect(root.profiles.claude?.preferences.maxConcurrentRuns).toBeUndefined();
  });

  it('batch-resolves and atomically saves multiple personal substitution targets', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    const lookup = vi.spyOn(h.channel.rawClient, 'request').mockResolvedValue({
      data: {
        user_list: [
          { email: 'first@example.com', user_id: 'ou_first_123456' },
          { email: 'second@example.com', user_id: 'ou_second_654321' },
        ],
      },
    });

    await h.command('/config submit', {
      personal_substitution_enabled: 'yes',
      personal_substitution_target_0: 'first@example.com',
      personal_substitution_target_1: 'second@example.com',
    });

    const root = await waitForRoot(
      h.rootDir,
      (candidate) => candidate.profiles.claude?.collaboration.personalSubstitution.enabled === true,
    );
    expect(root.profiles.claude?.collaboration.personalSubstitution).toEqual({
      enabled: true,
      targetOpenIds: ['ou_first_123456', 'ou_second_654321'],
    });
    expect(lookup).toHaveBeenCalledWith({
      method: 'POST',
      url: '/open-apis/contact/v3/users/batch_get_id',
      params: { user_id_type: 'open_id' },
      data: { emails: ['first@example.com', 'second@example.com'] },
    });

    await h.command('/config submit', {
      personal_substitution_enabled: 'no',
      personal_substitution_target_0: '…123456 [substitution saved 0]',
      personal_substitution_target_1: '…654321 [substitution saved 1]',
    });
    const disabled = await waitForRoot(
      h.rootDir,
      (candidate) =>
        candidate.profiles.claude?.collaboration.personalSubstitution.enabled === false &&
        candidate.profiles.claude?.collaboration.personalSubstitution.targetOpenIds.length === 2,
    );
    expect(disabled.profiles.claude?.collaboration.personalSubstitution).toEqual({
      enabled: false,
      targetOpenIds: ['ou_first_123456', 'ou_second_654321'],
    });
  });

  it('writes no config fields when any substitution target resolution is incomplete', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    vi.spyOn(h.channel.rawClient, 'request').mockResolvedValue({
      data: { user_list: [{ email: 'known@example.com', user_id: 'ou_known' }] },
    });

    await h.command('/config submit', {
      max_concurrent_runs: '9',
      personal_substitution_enabled: 'yes',
      personal_substitution_target_0: 'known@example.com',
      personal_substitution_target_1: 'unknown@example.com',
    });
    await vi.runAllTimersAsync();

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.collaboration.personalSubstitution).toEqual({
      enabled: false,
      targetOpenIds: [],
    });
    expect(root.profiles.claude?.preferences.maxConcurrentRuns).toBeUndefined();
    expect(JSON.stringify(h.channel.sent)).not.toMatch(/known@example|unknown@example|ou_known/);
  });

  it('writes nothing when a substitution config draft is cancelled', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    const lookup = vi.spyOn(h.channel.rawClient, 'request');

    await h.command('/config cancel', {
      personal_substitution_enabled: 'yes',
      personal_substitution_target_0: 'target@example.com',
    });
    await vi.runAllTimersAsync();

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.collaboration.personalSubstitution).toEqual({
      enabled: false,
      targetOpenIds: [],
    });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('preserves unsaved substitution drafts through add and delete card actions', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    await h.command('/config');
    h.channel.rawClient.requests.splice(0);

    await h.command(
      '/config substitution-add 0,1',
      {
        personal_substitution_enabled: 'yes',
        personal_substitution_target_0: 'draft@example.com',
      },
      'om_fake_1',
    );
    await vi.runAllTimersAsync();
    const added = JSON.stringify(h.channel.rawClient.requests.at(-1));
    expect(added).toContain('draft@example.com');
    expect(added).toContain('personal_substitution_target_1');

    await h.command(
      '/config substitution-delete 0,2,1',
      {
        personal_substitution_enabled: 'yes',
        personal_substitution_target_0: 'draft@example.com',
        personal_substitution_target_1: 'remove@example.com',
      },
      'om_fake_1',
    );
    await vi.runAllTimersAsync();
    const deleted = JSON.stringify(h.channel.rawClient.requests.at(-1));
    expect(deleted).toContain('draft@example.com');
    expect(deleted).not.toContain('remove@example.com');
  });

  it('saves /account submit into the active profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(
      h.rootDir,
      (candidate) => candidate.profiles.claude?.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(3);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'keystore',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(
        secretKeyForApp('cli_new'),
        resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' }),
      ),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(listSecretIds(codexPaths)).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(
  options: { preferences?: RootConfig['profiles'][string]['preferences'] } = {},
): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  command(
    content: string,
    formValue?: Record<string, unknown>,
    messageId?: string,
  ): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, options.preferences);
  const appPaths = resolveAppPaths({ rootDir, profile: 'claude' });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: 'claude',
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, 'claude'),
    processId: 'proc-1',
  } satisfies Controls;
  const agent = new FakeAgentAdapter();
  const activeRuns = new ActiveRuns();
  const scopedRuns = createTestScopedRuns({
    agent,
    activeRuns,
    workspaces,
    profileConfig: () => controls.cfg,
  });

  return {
    rootDir,
    channel,
    command: (content: string, formValue?: Record<string, unknown>, messageId?: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content, messageId),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        scopedRuns,
        controls,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 3,
    activeProfile: 'claude',
    profiles: {
      claude: createDefaultProfileConfig({
        app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        omp: { binaryPath: '/usr/local/bin/omp' },
      }),
    },
  };
  const profile = root.profiles.claude;
  if (!profile) throw new Error('missing claude profile');
  profile.workspaces.default = workspace;
  profile.preferences = {
    ...profile.preferences,
    ...preferences,
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(
    async () => {
      lastRoot = await readRoot(rootDir);
      expect(predicate(lastRoot)).toBe(true);
    },
    { timeout: 5000 },
  );
  return lastRoot;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string, messageId?: string): NormalizedMessage {
  return {
    messageId: messageId ?? `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
