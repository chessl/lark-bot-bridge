import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { runtimeLockMetaFile } from '../../../src/runtime/locks';
import { withRuntimeLocks } from '../../helpers/runtime-locks';
import {
  type ProcessEntry,
  readRegistry,
  register,
  unregisterSync,
} from '../../../src/runtime/registry';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-registry-locks-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('registry and runtime lock integration', () => {
  it('keeps read paths read-only while write paths prune stale lock entries', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [
        entry({ id: 'stale-a', pid: 999_999_991, profileName: 'work', appId: 'cli_old' }),
        entry({ id: 'stale-b', pid: process.pid, profileName: 'personal', appId: 'cli_other' }),
      ],
    });
    const before = await readFile(registryFile, 'utf8');

    expect(readRegistry(registryFile).map((item) => item.id)).toEqual(['stale-a', 'stale-b']);
    expect(await readFile(registryFile, 'utf8')).toBe(before);

    const registered = await register({
      appId: 'cli_new',
      tenant: 'feishu',
      profileName: 'personal',
      configPath: join(root, 'config.json'),
      version: '0.1.32',
      registryFile,
    });

    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as {
      entries: ProcessEntry[];
    };
    expect(persisted.entries.map((item) => item.id)).toEqual([registered.id]);
    expect(persisted.entries[0]).toMatchObject({
      appId: 'cli_new',
      profileName: 'personal',
      pid: process.pid,
    });
  });

  it('uses active profile/app locks instead of PID liveness when pruning writes', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const lockedEntry = entry({
      id: 'locked',
      pid: process.pid,
      profileName: 'work',
      appId: 'cli_existing',
    });
    await writeJson(registryFile, { entries: [lockedEntry] });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'work' });
    await withRuntimeLocks(lockedPaths, 'cli_existing', async () => {
      const registered = await register({
        appId: 'cli_new',
        tenant: 'feishu',
        profileName: 'personal',
        configPath: join(root, 'config.json'),
        version: '0.1.32',
        registryFile,
      });

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as {
        entries: ProcessEntry[];
      };
      expect(persisted.entries.map((item) => item.id)).toEqual(['locked', registered.id]);
    });
  });

  it('does not keep stale entries just because a new holder owns the same app lock', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, {
      entries: [
        entry({
          id: 'stale-same-app',
          pid: 999_999_992,
          profileName: 'work',
          appId: 'cli_existing',
        }),
      ],
    });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'work' });
    await withRuntimeLocks(lockedPaths, 'cli_existing', async () => {
      const registered = await register({
        appId: 'cli_new',
        tenant: 'feishu',
        profileName: 'personal',
        configPath: join(root, 'config.json'),
        version: '0.1.32',
        registryFile,
      });

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as {
        entries: ProcessEntry[];
      };
      expect(persisted.entries.map((item) => item.id)).toEqual([registered.id]);
    });
  });

  it('fails closed instead of pruning when live lock metadata is unreadable', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const lockedEntry = entry({
      id: 'locked',
      pid: process.pid,
      profileName: 'work',
      appId: 'cli_existing',
    });
    await writeJson(registryFile, { entries: [lockedEntry] });

    const lockedPaths = resolveAppPaths({ rootDir: root, profile: 'work' });
    await withRuntimeLocks(lockedPaths, 'cli_existing', async () => {
      await writeFile(runtimeLockMetaFile(lockedPaths.profileLockFile), 'not json', 'utf8');

      await expect(
        register({
          appId: 'cli_new',
          tenant: 'feishu',
          profileName: 'personal',
          configPath: join(root, 'config.json'),
          version: '0.1.32',
          registryFile,
        }),
      ).rejects.toThrow(/runtime lock state unknown/);

      const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as {
        entries: ProcessEntry[];
      };
      expect(persisted.entries.map((item) => item.id)).toEqual(['locked']);
    });
  });

  it('uses the registry file lock from sync unregister paths', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await writeJson(registryFile, { entries: [entry({ id: 'remove-me' })] });

    unregisterSync('remove-me', registryFile);

    const persisted = JSON.parse(await readFile(registryFile, 'utf8')) as {
      entries: ProcessEntry[];
    };
    expect(persisted.entries).toEqual([]);
  });
});

function entry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    profileName: 'work',
    ...overrides,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
