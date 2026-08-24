import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runProfileCreate,
  runProfileExport,
  runProfileRemove,
} from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { clearKeystoreDerivedKeyCache, setSecret } from '../../../src/config/keystore';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';
import { withRuntimeLocks } from '../../helpers/runtime-locks';
import type { ProcessEntry } from '../../../src/runtime/registry';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Recreated Bot' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile retention and export', () => {
  it('ignores stale registry entries that are not protected by a runtime lock', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude', 'codex-dev']);
    await writeRegistry(root, [processEntry({ profileName: 'codex-dev' })]);

    await runProfileRemove('codex-dev', { rootDir: root });

    await expect(stat(join(root, 'profiles', 'codex-dev'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to remove a profile while its runtime lock is active', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude', 'codex-dev']);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });

    await withRuntimeLocks(appPaths, 'cli_codex_dev', async () => {
      await expect(runProfileRemove('codex-dev', { rootDir: root })).rejects.toThrow(
        /locked|running/i,
      );
    });

    await expect(stat(join(root, 'profiles', 'codex-dev'))).resolves.toBeDefined();
  });

  it('archives inactive profiles by default and preserves root config on archive failure', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude', 'codex-dev']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));

    await runProfileRemove('codex-dev', { rootDir: root });

    const archived = join(root, '.trash', 'codex-dev-20260525T123456Z');
    await expect(stat(archived)).resolves.toBeDefined();
    await expect(stat(join(root, 'profiles', 'codex-dev'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(Object.keys(await readRoot(root))).toContain('profiles');
    expect((await readRoot(root)).profiles['codex-dev']).toBeUndefined();
    expect(logs.join('\n')).toContain('已归档 profile');

    const failRoot = await makeRoot();
    await writeProfiles(failRoot, 'claude', ['claude', 'codex-dev']);
    await writeFile(join(failRoot, '.trash'), 'not a directory');
    await expect(runProfileRemove('codex-dev', { rootDir: failRoot })).rejects.toThrow();
    expect((await readRoot(failRoot)).profiles['codex-dev']).toBeDefined();
    await expect(stat(join(failRoot, 'profiles', 'codex-dev'))).resolves.toBeDefined();
  });

  it('archives the active profile and switches to another configured profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['claude', 'codex-dev']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));

    await runProfileRemove('codex-dev', { rootDir: root });

    const config = await readRoot(root);
    expect(config.activeProfile).toBe('claude');
    expect(config.profiles['codex-dev']).toBeUndefined();
    await expect(stat(join(root, '.trash', 'codex-dev-20260525T123456Z'))).resolves.toBeDefined();
  });

  it('refuses removal when the active profile is missing', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'missing', ['claude', 'codex-dev']);

    await expect(runProfileRemove('codex-dev', { rootDir: root })).rejects.toThrow(
      /active profile not found: missing/,
    );
  });

  it('archives the last active profile and clears root config so the name can be recreated', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'omp', ['omp']);
    const omp = await writeVersionExecutable(root, 'omp-bin', 'omp 1.0');
    const oldOmpBin = process.env.LARK_CHANNEL_OMP_BIN;
    process.env.LARK_CHANNEL_OMP_BIN = omp;

    try {
      await runProfileRemove('omp', { rootDir: root });

      await expect(stat(join(root, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'profiles', 'omp'))).rejects.toMatchObject({ code: 'ENOENT' });
      await runProfileCreate('omp', {
        rootDir: root,
        appId: 'cli_recreated',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    } finally {
      if (oldOmpBin === undefined) {
        delete process.env.LARK_CHANNEL_OMP_BIN;
      } else {
        process.env.LARK_CHANNEL_OMP_BIN = oldOmpBin;
      }
    }
    const config = await readRoot(root);
    expect(config.activeProfile).toBe('omp');
    expect(config.profiles.omp?.omp.binaryPath).toBe(omp);
  });

  it('adds a suffix when archive names collide', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude', 'codex-dev']);
    await mkdir(join(root, '.trash', 'codex-dev-20260525T123456Z'), { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));

    await runProfileRemove('codex-dev', { rootDir: root });

    await expect(stat(join(root, '.trash', 'codex-dev-20260525T123456Z-1'))).resolves.toBeDefined();
  });

  it('purges only with --purge --yes', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude', 'codex-dev']);

    await expect(runProfileRemove('codex-dev', { rootDir: root, purge: true })).rejects.toThrow(
      /--yes/,
    );
    await runProfileRemove('codex-dev', { rootDir: root, purge: true, yes: true });

    await expect(stat(join(root, 'profiles', 'codex-dev'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(root, '.trash'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports profiles without secrets by default and requires --yes for secrets', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('claude', { rootDir: root });
    const exported = JSON.parse(lines.join('\n')) as RootConfig;

    expect(JSON.stringify(exported)).not.toContain('plain-secret');
    expect(exported.profiles.claude?.app.secret).toBe('[REDACTED]');
    await expect(
      runProfileExport('claude', { rootDir: root, includeSecrets: true }),
    ).rejects.toThrow(/--yes/);
  });

  it('materializes keystore app secret only when exporting with secrets', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);
    const appId = 'cli_claude';
    const exportedSecret = 'test-export-secret-from-keystore';
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const rootConfig = await readRoot(root);
    rootConfig.profiles.claude!.app.secret = {
      source: 'keystore',
      id: secretKeyForApp(appId),
    };
    await writeJson(join(root, 'config.json'), rootConfig);
    await setSecret(secretKeyForApp(appId), exportedSecret, appPaths);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('claude', { rootDir: root });
    const safeExport = JSON.parse(lines.pop() ?? '') as RootConfig;
    await runProfileExport('claude', { rootDir: root, includeSecrets: true, yes: true });
    const secretExport = JSON.parse(lines.pop() ?? '') as RootConfig;

    expect(JSON.stringify(safeExport)).not.toContain(exportedSecret);
    expect(safeExport.profiles.claude?.app.secret).toBe('[REDACTED]');
    expect(secretExport.profiles.claude?.app.secret).toBe(exportedSecret);
  });

  it('writes exports to a new output file and requires --force when it already exists', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);
    const output = join(root, 'profile-export.json');

    await runProfileExport('claude', { rootDir: root, output });
    await expect(readFile(output, 'utf8')).resolves.toContain('"activeProfile": "claude"');
    await expect(runProfileExport('claude', { rootDir: root, output })).rejects.toThrow(/--force/);
    await runProfileExport('claude', { rootDir: root, output, force: true });
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-retention-'));
  roots.push(root);
  return root;
}

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      app: {
        id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
        secret: 'plain-secret',
        tenant: 'feishu',
      },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    profiles,
  };
  await writeJson(join(root, 'config.json'), config);
}

async function readRoot(root: string): Promise<RootConfig> {
  return JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
}

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'claude',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    ...overrides,
  };
}

async function writeRegistry(root: string, entries: ProcessEntry[]): Promise<void> {
  await writeJson(resolveAppPaths({ rootDir: root }).userRegistryFile, { entries });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
