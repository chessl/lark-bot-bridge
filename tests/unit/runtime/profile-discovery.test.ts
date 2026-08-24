import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { saveRootConfig } from '../../../src/config/profile-store';
import { listAllProfiles } from '../../../src/runtime/profile-discovery';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bridge-profile-discovery-'));
  roots.push(value);
  return value;
}

function profile(appId: string) {
  return createDefaultProfileConfig({
    app: { id: appId, secret: 'secret', tenant: 'feishu' },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
}

async function writeRootConfig(rootDir: string, rootConfig: Omit<RootConfig, 'schemaVersion'>) {
  await saveRootConfig({ schemaVersion: 3, ...rootConfig }, join(rootDir, 'config.json'));
}

describe('profile discovery', () => {
  it('returns the active profile first and no engine discriminator', async () => {
    const rootDir = await root();
    await writeRootConfig(rootDir, {
      activeProfile: 'personal',
      profiles: {
        zeta: profile('cli_zeta'),
        work: profile('cli_work'),
        personal: profile('cli_personal'),
      },
    });
    await Promise.all(
      ['zeta', 'work', 'personal'].map((name) =>
        mkdir(join(rootDir, 'profiles', name), { recursive: true }),
      ),
    );

    const profiles = await listAllProfiles(rootDir);
    expect(profiles.map((item) => item.name)).toEqual(['personal', 'work', 'zeta']);
    expect(profiles.map((item) => item.active)).toEqual([true, false, false]);
    expect(profiles[0]).not.toHaveProperty('agentKind');
  });

  it('rejects a missing active profile', async () => {
    const rootDir = await root();
    await writeRootConfig(rootDir, {
      activeProfile: 'missing',
      profiles: { work: profile('cli_work') },
    });
    await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
    await expect(listAllProfiles(rootDir)).rejects.toThrow('active profile not found: missing');
  });

  it('rejects missing or orphan profile state directories', async () => {
    const rootDir = await root();
    await writeRootConfig(rootDir, {
      activeProfile: 'work',
      profiles: { work: profile('cli_work'), personal: profile('cli_personal') },
    });
    await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
    await expect(listAllProfiles(rootDir)).rejects.toThrow(
      'profile state directory missing: personal',
    );

    await mkdir(join(rootDir, 'profiles', 'personal'), { recursive: true });
    await mkdir(join(rootDir, 'profiles', 'orphan'), { recursive: true });
    await expect(listAllProfiles(rootDir)).rejects.toThrow(
      'profile state directory without config: orphan',
    );
  });
});
