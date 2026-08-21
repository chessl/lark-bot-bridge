import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAppPaths, resolveAppPaths } from '../../../src/config/app-paths';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-app-paths-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveAppPaths', () => {
  it('defaults to ~/.lark-bot-bridge', () => {
    const previous = process.env.LARK_CHANNEL_HOME;
    delete process.env.LARK_CHANNEL_HOME;
    try {
      expect(resolveAppPaths().rootDir).toBe(join(homedir(), '.lark-bot-bridge'));
    } finally {
      if (previous === undefined) delete process.env.LARK_CHANNEL_HOME;
      else process.env.LARK_CHANNEL_HOME = previous;
    }
  });

  it('exposes the process-wide defaults directly', () => {
    expect(defaultAppPaths.rootDir).toBe(resolveAppPaths().rootDir);
    expect(defaultAppPaths.profile).toBe(resolveAppPaths().profile);
  });

  it('keeps root config, active profile, registry, and locks under the user root', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });

    expect(paths.rootDir).toBe(root);
    expect(paths.profile).toBe('codex-dev');
    expect(paths.profilesDir).toBe(join(root, 'profiles'));
    expect(paths.trashDir).toBe(join(root, '.trash'));
    expect(paths.configFile).toBe(join(root, 'config.json'));
    expect(paths.registryDir).toBe(join(root, 'registry'));
    expect(paths.userRegistryFile).toBe(join(root, 'registry', 'processes.json'));
    expect(paths.userLockDir).toBe(join(root, 'registry', 'locks'));
    expect(paths.profileLockFile).toBe(
      join(root, 'registry', 'locks', 'profile', 'codex-dev.lock'),
    );
    expect(paths.appLockFile('cli/app')).toBe(
      join(root, 'registry', 'locks', 'app', 'cli_app.lock'),
    );
    expect(paths.userAuthLockTarget('cli/app')).toBe(
      join(root, 'registry', 'locks', 'user-auth', 'cli_app'),
    );
    expect(paths.hostUiFile).toBe(join(root, 'ui.json'));
    expect(paths.hostLogsDir).toBe(join(root, 'logs'));
    expect(paths.hostLockFile).toBe(join(root, 'registry', 'locks', 'supervisor.lock'));
  });

  it('places runtime state inside the selected profile directory', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });

    const profileDir = join(root, 'profiles', 'claude');
    expect(paths.profileDir).toBe(profileDir);
    expect(paths.codexHomeDir).toBe(join(profileDir, 'codex-home'));
    expect(paths.defaultWorkspaceDir).toBe(join(`${root}-workspaces`, 'claude', 'default'));
    expect(paths.sessionsFile).toBe(join(profileDir, 'sessions.json'));
    expect(paths.sessionCatalogFile).toBe(join(profileDir, 'sessions.json.catalog.json'));
    expect(paths.workspacesFile).toBe(join(profileDir, 'workspaces.json'));
    expect(paths.secretsFile).toBe(join(profileDir, 'secrets.enc'));
    expect(paths.keystoreSaltFile).toBe(join(profileDir, '.keystore.salt'));
    expect(paths.userAuthFile).toBe(join(profileDir, 'user-auth.json'));
    expect(paths.mediaDir).toBe(join(profileDir, 'media'));
    expect(paths.callbackNoncesFile).toBe(join(profileDir, 'callback-nonces.json'));
    expect(paths.logsDir).toBe(join(profileDir, 'logs'));
    expect(paths.daemonLogsDir).toBe(join(profileDir, 'logs', 'daemon'));
    expect(paths.daemonStdoutFile).toBe(join(profileDir, 'logs', 'daemon', 'daemon-stdout.log'));
    expect(paths.daemonStderrFile).toBe(join(profileDir, 'logs', 'daemon', 'daemon-stderr.log'));
    expect(paths.uiFile).toBe(join(profileDir, 'ui.json'));
    expect(paths.secretsGetterScript).toBe(join(root, 'secrets-getter'));
  });

  it('uses LARK_CHANNEL_HOME only for the root directory, not profile selection', async () => {
    const root = await tempRoot();
    const prev = process.env.LARK_CHANNEL_HOME;
    process.env.LARK_CHANNEL_HOME = root;
    try {
      const paths = resolveAppPaths({ profile: 'operator-choice' });
      expect(paths.rootDir).toBe(root);
      expect(paths.profile).toBe('operator-choice');
      expect(paths.profileDir).toBe(join(root, 'profiles', 'operator-choice'));
    } finally {
      if (prev === undefined) {
        delete process.env.LARK_CHANNEL_HOME;
      } else {
        process.env.LARK_CHANNEL_HOME = prev;
      }
    }
  });

  it('rejects profile names that are unsafe POSIX path segments', async () => {
    const root = await tempRoot();

    expect(() => resolveAppPaths({ rootDir: root, profile: 'codex dev' })).toThrow(
      /invalid profile name/i,
    );
    expect(() => resolveAppPaths({ rootDir: root, profile: 'b64_Y29kZXggZGV2' })).not.toThrow();
    // POSIX path separators and reserved dot segments are still rejected.
    expect(() => resolveAppPaths({ rootDir: root, profile: 'a/b' })).toThrow(
      /invalid profile name/i,
    );
    expect(() => resolveAppPaths({ rootDir: root, profile: '..' })).toThrow(
      /invalid profile name/i,
    );
  });

  it('accepts Unicode profile names (e.g. a Chinese bot name) as a directory segment', async () => {
    const root = await tempRoot();

    const paths = resolveAppPaths({ rootDir: root, profile: '助手' });

    expect(paths.profile).toBe('助手');
    expect(paths.profileDir).toBe(join(root, 'profiles', '助手'));
    expect(paths.profileLockFile).toBe(join(root, 'registry', 'locks', 'profile', '助手.lock'));
  });
});
