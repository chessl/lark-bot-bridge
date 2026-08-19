import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const wizard = vi.hoisted(() => ({
  next: {
    accounts: {
      app: {
        id: 'cli_wizard',
        secret: 'wizard-secret',
        tenant: 'feishu' as const,
      },
    },
    preferences: {},
  },
}));

const auth = vi.hoisted(() => {
  type ValidationMockResult = { ok: boolean; botName?: string; reason?: string };
  return {
    validateAppCredentials: vi.fn(
      async (): Promise<ValidationMockResult> => ({ ok: true, botName: 'Bridge Bot' }),
    ),
  };
});

vi.mock('../../../src/bot/wizard', () => ({
  runRegistrationWizard: vi.fn(async () => wizard.next),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile runtime resolver', () => {
  it('bootstraps first-run profile from existing app credentials without QR registration', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      workspace,
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      activeProfile: string;
      profiles: Record<string, { accounts: { app: { id: string; secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const secret = await getSecret(secretKeyForApp('cli_existing'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_existing',
      'manual-secret',
      'feishu',
    );
    expect(runtime.profile).toBe('claude');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('claude');
    expect(saved.profiles.claude?.accounts.app.id).toBe('cli_existing');
    expect(saved.profiles.claude?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_existing',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('rejects existing app bootstrap without writing config when credentials are invalid', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    auth.validateAppCredentials.mockResolvedValueOnce({ ok: false, reason: 'code=999' });

    await expect(
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        agent: 'claude',
        workspace,
        allowBootstrap: true,
        appId: 'cli_bad',
        appSecret: 'bad-secret',
        tenant: 'feishu',
      } as Parameters<typeof resolveProfileRuntime>[0] & {
        appId: string;
        appSecret: string;
        tenant: 'feishu';
      }),
    ).rejects.toThrow(/code=999/);
    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly instead of opening the QR wizard during non-interactive first run', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'claude',
          allowBootstrap: true,
        }),
      ).rejects.toThrow(/非交互模式无法完成扫码创建应用/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly when non-interactive existing-app bootstrap omits the app secret', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'claude',
          allowBootstrap: true,
          appId: 'cli_missing_secret',
          tenant: 'feishu',
        }),
      ).rejects.toThrow(/非交互模式缺少 App Secret/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bootstraps a managed default workspace when no workspace is provided', async () => {
    const root = await tmpRoot();

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'claude',
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    } as Parameters<typeof resolveProfileRuntime>[0] & {
      appId: string;
      appSecret: string;
      tenant: 'feishu';
    });

    const managed = await realpath(
      resolveAppPaths({ rootDir: root, profile: 'claude' }).defaultWorkspaceDir,
    );
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.claude?.workspaces?.default).toBe(managed);
  });

  it('reports detected local agents when first-run agent selection is ambiguous', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const claude = await writeExecutable(bin, 'claude');
    const codex = await writeExecutable(bin, 'codex');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_CLAUDE_BIN;
    delete process.env.LARK_CHANNEL_CODEX_BIN;

    try {
      let error: Error | undefined;
      try {
        await resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
          selectAgent: () => undefined,
        });
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        error = err;
      }

      expect(error).toBeDefined();
      const message = error?.message ?? '';
      expect(message).toContain('检测到多个本地 agent');
      expect(message).toContain('claude');
      expect(message).toContain(claude);
      expect(message).toContain('codex');
      expect(message).toContain(codex);
      expect(message).toContain('--agent <claude|codex|omp>');
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
    }
  });

  it('continues first-run bootstrap with the selected local agent when multiple are detected', async () => {
    const root = await tmpRoot();
    const bin = join(root, 'bin');
    const codex = await writeExecutable(bin, 'codex');
    await writeExecutable(bin, 'claude');
    const oldPath = process.env.PATH;
    const oldClaude = process.env.LARK_CHANNEL_CLAUDE_BIN;
    const oldCodex = process.env.LARK_CHANNEL_CODEX_BIN;
    process.env.PATH = bin;
    delete process.env.LARK_CHANNEL_CLAUDE_BIN;
    delete process.env.LARK_CHANNEL_CODEX_BIN;

    try {
      const runtime = await withTty(true, true, () =>
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          allowBootstrap: true,
          selectAgent: (detected) => {
            expect(detected.map((agent) => agent.kind)).toEqual(['claude', 'codex']);
            return 'codex';
          },
        }),
      );

      expect(runtime.profile).toBe('codex');
      expect(runtime.profileConfig.agentKind).toBe('codex');
      expect(runtime.profileConfig.codex?.binaryPath).toBe(codex);
    } finally {
      process.env.PATH = oldPath;
      if (oldClaude === undefined) {
        delete process.env.LARK_CHANNEL_CLAUDE_BIN;
      } else {
        process.env.LARK_CHANNEL_CLAUDE_BIN = oldClaude;
      }
      if (oldCodex === undefined) {
        delete process.env.LARK_CHANNEL_CODEX_BIN;
      } else {
        process.env.LARK_CHANNEL_CODEX_BIN = oldCodex;
      }
    }
  });

  it('resolves the active Codex profile from root config', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex-dev', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profile).toBe('codex-dev');
    expect(runtime.profileConfig.agentKind).toBe('codex');
    expect(runtime.appPaths.profileDir).toBe(join(root, 'profiles', 'codex-dev'));
  });

  it('keeps explicit canonical lower permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const claude = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    await writeProfileRoot(root, 'claude', { claude });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { permissions?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles.claude?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
  });

  it('keeps explicit canonical Codex home and user-config isolation settings', async () => {
    const root = await tmpRoot();
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        inheritCodexHome: false,
        ignoreUserConfig: true,
      },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
      },
    });
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': codex,
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<
        string,
        { codex?: { inheritCodexHome?: boolean; ignoreUserConfig?: boolean } }
      >;
    };

    expect(runtime.profileConfig.codex?.inheritCodexHome).toBe(false);
    expect(runtime.profileConfig.codex?.ignoreUserConfig).toBe(true);
    expect(saved.profiles['codex-dev']?.codex?.inheritCodexHome).toBe(false);
    expect(saved.profiles['codex-dev']?.codex?.ignoreUserConfig).toBe(true);
  });

  it('lets an explicit profile override active-profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex-dev', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'claude',
    });

    expect(runtime.profile).toBe('claude');
    expect(runtime.profileConfig.agentKind).toBe('claude');
  });

  it('rejects an explicit agent that conflicts with an existing profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'codex', {
      codex: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    });

    let error: Error | undefined;
    try {
      await resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'codex',
        agent: 'codex',
        allowBootstrap: true,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      error = err;
    }

    expect(error).toBeDefined();
    const message = error?.message ?? '';
    expect(message).toContain('profile codex already exists with agentKind claude');
    expect(message).toContain('requested --agent codex');
    expect(message).toContain('Profile names are labels');
    expect(message).toContain('omit --agent');
    expect(message).toContain('remove profile codex');
  });

  it('fails when active-profile points at a missing profile instead of falling back', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'missing-profile', {
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
    });

    await expect(resolveProfileRuntime({ config: join(root, 'config.json') })).rejects.toThrow(
      /profile not found/i,
    );
  });

  it('bootstraps an explicit missing profile into existing root config', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: { app: { ...app, id: 'cli_codex' } },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });
    wizard.next = {
      accounts: {
        app: {
          id: 'cli_claude_work',
          secret: 'new-profile-secret',
          tenant: 'feishu',
        },
      },
      preferences: {},
    };

    const runtime = await withTty(true, true, () =>
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'claude-work',
        agent: 'claude',
        workspace,
        allowBootstrap: true,
      }),
    );
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      activeProfile: string;
      profiles: Record<string, { agentKind: string; accounts: { app: { id: string } } }>;
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude-work' });
    const secret = await getSecret(secretKeyForApp('cli_claude_work'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(runtime.profile).toBe('claude-work');
    expect(runtime.profileConfig.agentKind).toBe('claude');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('codex-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('codex-dev\n');
    expect(saved.profiles['codex-dev']?.agentKind).toBe('codex');
    expect(saved.profiles['claude-work']?.agentKind).toBe('claude');
    expect(saved.profiles['claude-work']?.accounts.app.id).toBe('cli_claude_work');
    expect(secret).toBe('new-profile-secret');
  });

  it('normalizes stored profiles before exposing runtime config', async () => {
    const root = await tmpRoot();
    const codex = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { ...app, id: 'cli_codex' } },
      codex: { binaryPath: '/usr/local/bin/codex' },
    }) as unknown as Record<string, unknown>;
    codex.codex = {
      ...(codex.codex as Record<string, unknown>),
      flags: ['--danger-full-access'],
    };
    codex.workspaces = {
      default: '/repo/project',
      trustedRoots: ['/repo'],
    };
    await writeProfileRoot(root, 'codex-dev', { 'codex-dev': codex });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profileConfig.workspaces.default).toBe('/repo/project');
    expect(runtime.profileConfig.codex).not.toHaveProperty('flags');
  });

  it('materializes env-backed secrets into encrypted profile storage for service mode', async () => {
    const root = await tmpRoot();
    process.env.BRIDGE_TEST_APP_SECRET = 'service-mode-secret';
    await writeProfileRoot(root, 'codex-dev', {
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: {
            id: 'cli_codex',
            secret: { source: 'env', id: 'BRIDGE_TEST_APP_SECRET' },
            tenant: 'feishu',
          },
        },
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
    });

    const changed = await materializeEnvSecretForService({
      config: join(root, 'config.json'),
      profile: 'codex-dev',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { accounts: { app: { secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });
    const secret = await getSecret(secretKeyForApp('cli_codex'), appPaths);
    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'codex-dev',
      allowBootstrap: false,
    });
    const projectionPath = await writeLarkCliSourceProjection(runtime.cfg, appPaths);
    const projectionText = await readFile(projectionPath, 'utf8');
    const projection = JSON.parse(projectionText) as {
      accounts: { app: { secret: unknown } };
      secrets?: { providers?: Record<string, { command?: string; env?: Record<string, string> }> };
    };

    expect(changed).toBe(true);
    expect(saved.profiles['codex-dev']?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_codex',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(secret).toBe('service-mode-secret');
    expect(projectionText).not.toContain('${BRIDGE_TEST_APP_SECRET}');
    expect(projection.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_codex',
    });
    expect(projection.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(projection.secrets?.providers?.bridge?.env).toMatchObject({
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_PROFILE: 'codex-dev',
    });
  });
});

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-profile-runtime-'));
}

async function writeExecutable(root: string, name: string): Promise<string> {
  return writeVersionExecutable(root, name, 'ok');
}

function expectedSecretsGetter(root: string): string {
  return join(root, 'secrets-getter');
}

async function writeProfileRoot(
  root: string,
  activeProfile: string,
  profiles: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        activeProfile,
        preferences: {},
        ...extra,
        profiles,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`);
}

async function withTty<T>(stdinTTY: boolean, stdoutTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY });
  try {
    return await fn();
  } finally {
    restoreDescriptor(process.stdin, 'isTTY', stdinDesc);
    restoreDescriptor(process.stdout, 'isTTY', stdoutDesc);
  }
}

function restoreDescriptor(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  key: 'isTTY',
  desc: PropertyDescriptor | undefined,
): void {
  if (desc) {
    Object.defineProperty(target, key, desc);
  } else {
    delete (target as unknown as Record<string, unknown>)[key];
  }
}
