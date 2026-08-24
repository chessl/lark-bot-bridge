import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileCreate } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];
const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Work Bot' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-create-'));
  roots.push(root);
  return root;
}

async function withOmp<T>(root: string, fn: (binaryPath: string) => Promise<T>): Promise<T> {
  const binaryPath = await writeVersionExecutable(join(root, 'bin'), 'omp', 'omp 1.0');
  const previous = process.env.LARK_CHANNEL_OMP_BIN;
  process.env.LARK_CHANNEL_OMP_BIN = binaryPath;
  try {
    return await fn(binaryPath);
  } finally {
    if (previous === undefined) delete process.env.LARK_CHANNEL_OMP_BIN;
    else process.env.LARK_CHANNEL_OMP_BIN = previous;
  }
}

describe('profile create', () => {
  it('adds a named OMP profile without changing the active profile', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'personal', ['personal']);

    await withOmp(root, async (binaryPath) => {
      await runProfileCreate('work', {
        rootDir: root,
        workspace,
        appId: 'cli_work',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });

      const savedText = await readFile(join(root, 'config.json'), 'utf8');
      const saved = JSON.parse(savedText) as RootConfig;
      const appPaths = resolveAppPaths({ rootDir: root, profile: 'work' });
      expect(saved.activeProfile).toBe('personal');
      expect(saved.profiles.work?.omp.binaryPath).toBe(binaryPath);
      expect(saved.profiles.work?.workspaces.default).toBe(await realpath(workspace));
      expect(savedText).not.toContain('manual-secret');
      await expect(getSecret(secretKeyForApp('cli_work'), appPaths)).resolves.toBe('manual-secret');
    });
  });

  it('rejects duplicate profile names without rewriting config', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'work', ['work']);
    const configPath = join(root, 'config.json');
    const before = await readFile(configPath, 'utf8');

    await expect(
      runProfileCreate('work', {
        rootDir: root,
        appId: 'cli_other',
        appSecret: 'manual-secret',
      }),
    ).rejects.toThrow('profile already exists: work');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('reports a missing OMP executable', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'personal', ['personal']);
    const previous = process.env.LARK_CHANNEL_OMP_BIN;
    process.env.LARK_CHANNEL_OMP_BIN = join(root, 'missing-omp');
    try {
      await expect(
        runProfileCreate('work', {
          rootDir: root,
          appId: 'cli_work',
          appSecret: 'manual-secret',
        }),
      ).rejects.toMatchObject({ diagnostic: { agentId: 'omp' } });
    } finally {
      if (previous === undefined) delete process.env.LARK_CHANNEL_OMP_BIN;
      else process.env.LARK_CHANNEL_OMP_BIN = previous;
    }
  });
});

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      app: { id: `cli_${name}`, secret: 'secret', tenant: 'feishu' },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = { schemaVersion: 3, activeProfile, profiles };
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
