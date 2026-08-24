import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRootConfig } from '../../../src/config/profile-store';
import { writeNewProfile } from '../../../src/ui/onboard';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];
let previousOmp: string | undefined;

beforeEach(async () => {
  previousOmp = process.env.LARK_CHANNEL_OMP_BIN;
  const binRoot = await tmpRoot();
  process.env.LARK_CHANNEL_OMP_BIN = await writeVersionExecutable(binRoot, 'omp', 'omp 1.0');
});

afterEach(async () => {
  if (previousOmp === undefined) delete process.env.LARK_CHANNEL_OMP_BIN;
  else process.env.LARK_CHANNEL_OMP_BIN = previousOmp;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-onboard-'));
  roots.push(root);
  return root;
}

describe('writeNewProfile', () => {
  it('refuses to overwrite an existing profile and lets a new name coexist', async () => {
    const root = await tmpRoot();
    const base = {
      profile: 'personal',
      appSecret: 'secret',
      tenant: 'feishu' as const,
      workspace: root,
    };

    expect((await writeNewProfile({ ...base, appId: 'cli_a' }, root)).profile).toBe('personal');
    await expect(writeNewProfile({ ...base, appId: 'cli_b' }, root)).rejects.toThrow(/已存在/);
    expect((await loadRootConfig(join(root, 'config.json')))?.profiles.personal?.app.id).toBe(
      'cli_a',
    );

    expect(
      (await writeNewProfile({ ...base, profile: 'work', appId: 'cli_b' }, root)).profile,
    ).toBe('work');
    const config = await loadRootConfig(join(root, 'config.json'));
    expect(Object.keys(config?.profiles ?? {}).sort()).toEqual(['personal', 'work']);
    expect(config?.profiles.work?.omp.binaryPath).toBe(process.env.LARK_CHANNEL_OMP_BIN);
  });

  it('creates a profile with a Unicode name', async () => {
    const root = await tmpRoot();
    const created = await writeNewProfile(
      {
        profile: '助手',
        appId: 'cli_nimo',
        appSecret: 'secret',
        tenant: 'feishu',
        workspace: root,
      },
      root,
    );
    expect(created.profile).toBe('助手');
    expect((await loadRootConfig(join(root, 'config.json')))?.profiles.助手?.app.id).toBe(
      'cli_nimo',
    );
  });

  it('rejects a path-unsafe profile name with a clear 400', async () => {
    const root = await tmpRoot();
    await expect(
      writeNewProfile({ profile: 'a/b', appId: 'cli_x', appSecret: 's', tenant: 'feishu' }, root),
    ).rejects.toMatchObject({ status: 400 });
  });
});
