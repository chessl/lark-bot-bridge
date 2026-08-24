import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeAppSecret, setAppSecret } from '../../../src/cli/commands/secrets';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  clearKeystoreDerivedKeyCache,
  getSecret,
  keystoreDerivedKeyCacheSize,
  setSecret,
} from '../../../src/config/keystore';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-secrets-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware secrets commands', () => {
  it('sets and removes secrets in an explicit profile or the active profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'codex-dev', ['alpha', 'codex-dev']);

    await setAppSecret('cli_alpha', 'alpha-secret', { rootDir: root, profile: 'alpha' });
    await setAppSecret('cli_active', 'active-secret', { rootDir: root });

    await expect(
      getSecret(secretKeyForApp('cli_alpha'), resolveAppPaths({ rootDir: root, profile: 'alpha' })),
    ).resolves.toBe('alpha-secret');
    await expect(
      getSecret(
        secretKeyForApp('cli_active'),
        resolveAppPaths({ rootDir: root, profile: 'codex-dev' }),
      ),
    ).resolves.toBe('active-secret');

    await expect(removeAppSecret('cli_alpha', { rootDir: root, profile: 'alpha' })).resolves.toBe(
      true,
    );
    await expect(
      getSecret(secretKeyForApp('cli_alpha'), resolveAppPaths({ rootDir: root, profile: 'alpha' })),
    ).resolves.toBeUndefined();
  });

  it('caches the derived keystore key within one secrets process', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'claude', ['claude']);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await setSecret(secretKeyForApp('cli_one'), 'one', appPaths);
    await setSecret(secretKeyForApp('cli_two'), 'two', appPaths);
    clearKeystoreDerivedKeyCache();

    await expect(getSecret(secretKeyForApp('cli_one'), appPaths)).resolves.toBe('one');
    await expect(getSecret(secretKeyForApp('cli_two'), appPaths)).resolves.toBe('two');

    expect(keystoreDerivedKeyCacheSize()).toBe(1);
  });
});

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      app: {
        id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
      omp: { binaryPath: '/usr/local/bin/omp' },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = {
    schemaVersion: 3,
    activeProfile,
    profiles,
  };
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
