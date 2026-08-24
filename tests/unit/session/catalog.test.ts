import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalog, sessionCatalogKey } from '../../../src/session/catalog';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-session-catalog-'));
  roots.push(root);
  return join(root, 'catalog.json');
}

const identity = {
  scopeId: 'chat-1',
  cwdRealpath: '/repo',
  policyFingerprint: 'fp-1',
};

describe('OMP session catalog', () => {
  it('stores one active session per scope, cwd, and policy identity', async () => {
    const catalog = new SessionCatalog(await path());
    expect(catalog.activeFor(identity)).toBeUndefined();
    catalog.upsertActive({ ...identity, sessionId: 'omp-session-1', now: 1_000 });
    expect(catalog.activeFor(identity)).toMatchObject({
      sessionId: 'omp-session-1',
      status: 'active',
    });
    expect(catalog.activeFor({ ...identity, policyFingerprint: 'fp-2' })).toBeUndefined();
    await catalog.flush();
  });

  it('requires an OMP session id', async () => {
    const catalog = new SessionCatalog(await path());
    expect(() => catalog.upsertActive({ ...identity, sessionId: '' })).toThrow(/sessionId/);
  });

  it('archives only the matching active identity', async () => {
    const catalog = new SessionCatalog(await path());
    catalog.upsertActive({ ...identity, sessionId: 'omp-session-1', now: 1_000 });
    expect(catalog.archiveActive({ ...identity, now: 2_000 })).toBe(true);
    expect(catalog.activeFor(identity)).toBeUndefined();
    expect(catalog.entries()[0]).toMatchObject({ status: 'archived', updatedAt: 2_000 });
    await catalog.flush();
  });

  it('drops obsolete and malformed persisted entry shapes on load', async () => {
    const file = await path();
    await writeFile(
      file,
      JSON.stringify([
        {
          key: 'legacy-key',
          ...identity,
          status: 'active',
          updatedAt: 1_000,
          threadId: 'legacy-thread',
        },
        {
          key: sessionCatalogKey(identity),
          ...identity,
          status: 'active',
          updatedAt: 2_000,
          sessionId: 'omp-session-2',
        },
      ]),
    );
    const catalog = new SessionCatalog(file);
    await catalog.load();
    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.activeFor(identity)?.sessionId).toBe('omp-session-2');
  });

  it('garbage-collects old archives and enforces size caps', async () => {
    const file = await path();
    const catalog = new SessionCatalog(file);
    for (let index = 0; index < 4; index++) {
      const item = { ...identity, policyFingerprint: `fp-${index}` };
      catalog.upsertActive({ ...item, sessionId: `session-${index}`, now: index });
      if (index === 0) catalog.archiveActive({ ...item, now: 0 });
    }
    catalog.gc({ now: 10_000, maxArchivedAgeMs: 100, maxEntriesPerScope: 2 });
    expect(catalog.entries()).toHaveLength(2);
    await catalog.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(2);
  });
});
