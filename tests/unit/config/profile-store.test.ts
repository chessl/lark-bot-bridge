import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];
const app = { id: 'cli_test', secret: 'secret', tenant: 'feishu' as const };
const omp = { binaryPath: '/usr/local/bin/omp', profile: 'work' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-store-'));
  roots.push(root);
  return root;
}

describe('OMP profile store', () => {
  it('saves only canonical root and profile fields', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = {
      ...createDefaultProfileConfig({
        accounts: { app },
        omp,
        preferences: { model: 'custom-model', maxConcurrentRuns: 4 },
        access: { allowedUsers: ['ou_user'], requireMentionInGroup: false },
      }),
      workspaces: { default: '/repo' },
      runtimeOnlyFutureField: true,
    };

    await saveRootConfig(
      {
        schemaVersion: 2,
        activeProfile: 'work',
        profiles: { work: profile },
        extra: true,
      } as unknown as RootConfig & { extra: true },
      configPath,
    );

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved).not.toHaveProperty('extra');
    expect(saved.profiles.work.omp).toEqual(omp);
    expect(saved.profiles.work.workspaces).toEqual({ default: '/repo' });
    expect(saved.profiles.work).not.toHaveProperty('runtimeOnlyFutureField');
    expect(saved.profiles.work).not.toHaveProperty('agentKind');
    expect(saved.profiles.work).not.toHaveProperty('permissions');
  });

  it('requires OMP configuration when loading', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        activeProfile: 'work',
        profiles: { work: { accounts: { app } } },
      }),
    );

    await expect(loadRootConfig(configPath)).rejects.toThrow(/omp profile requires/);
  });

  it('persists deployment, access, and meeting settings across save and load', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({ mode: 'team', accounts: { app }, omp });
    profile.access.chatRequireMention = { oc_open: false, oc_strict: true };
    profile.meeting = { ...profile.meeting, enabled: true, respondIn: 'both' };

    await saveRootConfig(
      { schemaVersion: 2, activeProfile: 'work', profiles: { work: profile } },
      configPath,
    );
    const loaded = await loadRootConfig(configPath);

    expect(loaded?.profiles.work?.mode).toBe('team');
    expect(loaded?.profiles.work?.access.chatRequireMention).toEqual({
      oc_open: false,
      oc_strict: true,
    });
    expect(loaded?.profiles.work?.meeting).toMatchObject({ enabled: true, respondIn: 'both' });
    expect(loaded?.profiles.work?.omp).toEqual(omp);
  });
});
