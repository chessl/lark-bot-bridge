import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import type { RuntimeLockConflictError } from '../../../src/runtime/locks';
import { withProfileAndAppLocks } from '../../../src/runtime/locks';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-locks-'));
  roots.push(root);
  return root;
}

describe('runtime locks', () => {
  it('acquires profile then app locks and writes OMP-neutral metadata', async () => {
    const paths = resolveAppPaths({ rootDir: await makeRoot(), profile: 'work' });
    await withProfileAndAppLocks(paths, 'cli_test', async (locks) => {
      expect(locks.map((lock) => lock.kind)).toEqual(['profile', 'app']);
      for (const lock of locks) {
        expect((await stat(lock.target)).mode & 0o777).toBe(0o600);
        const meta = JSON.parse(await readFile(`${lock.target}.meta.json`, 'utf8'));
        expect(meta).toMatchObject({ profile: 'work', pid: process.pid });
        expect(meta).not.toHaveProperty('agentKind');
      }
    });
  });

  it('reports profile and app conflicts with the holder metadata', async () => {
    const root = await makeRoot();
    const work = resolveAppPaths({ rootDir: root, profile: 'work' });
    const personal = resolveAppPaths({ rootDir: root, profile: 'personal' });

    await withProfileAndAppLocks(work, 'cli_test', async () => {
      await expect(withProfileAndAppLocks(work, 'cli_other', async () => {})).rejects.toMatchObject(
        {
          kind: 'profile',
          meta: {
            kind: 'profile',
            target: work.profileLockFile,
            profile: 'work',
            pid: process.pid,
            startedAt: expect.any(String),
          },
        } satisfies Partial<RuntimeLockConflictError>,
      );
      await expect(
        withProfileAndAppLocks(personal, 'cli_test', async () => {}),
      ).rejects.toMatchObject({
        kind: 'app',
        meta: {
          kind: 'app',
          target: work.appLockFile('cli_test'),
          profile: 'work',
          appId: 'cli_test',
          pid: process.pid,
          startedAt: expect.any(String),
        },
      } satisfies Partial<RuntimeLockConflictError>);
    });
  });
});
