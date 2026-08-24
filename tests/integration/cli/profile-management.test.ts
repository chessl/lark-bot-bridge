import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileList, runProfileUse } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import type { ProcessEntry } from '../../../src/runtime/registry';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-management-'));
  roots.push(root);
  return root;
}

describe('profile management commands', () => {
  it('lists the active profile first with running pid and no engine column', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'personal', ['alpha', 'work', 'personal']);
    await writeRegistry(root, [processEntry({ pid: 12345, profileName: 'personal' })]);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileList({ rootDir: root });

    expect(lines).toEqual([
      'ACTIVE  PROFILE   STATUS',
      '*       personal  pid=12345',
      '        alpha     -',
      '        work      -',
    ]);
  });

  it('switches active profile without rewriting running process entries', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'work', ['work', 'personal']);
    const registryFile = resolveAppPaths({ rootDir: root }).userRegistryFile;
    await writeJson(registryFile, { entries: [processEntry({ profileName: 'work' })] });
    const beforeRegistry = await readFile(registryFile, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runProfileUse('personal', { rootDir: root });

    const rootConfig = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    expect(rootConfig.activeProfile).toBe('personal');
    expect(await readFile(registryFile, 'utf8')).toBe(beforeRegistry);
  });
});

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      app: {
        id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
        secret: 'secret',
        tenant: 'feishu',
      },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  await writeJson(join(root, 'config.json'), { schemaVersion: 3, activeProfile, profiles });
}

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'work',
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
