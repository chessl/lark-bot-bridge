import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('OMP run-flow resume', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes a catalog session when scope, cwd, and policy fingerprint match', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: first.run.metadata.policyFingerprint,
      sessionId: 'omp-session-catalog',
      now: 1_000,
    });

    const resumed = await start(h);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.run.metadata.resumeFrom).toBe('omp-session-catalog');
    expect(h.agent.runOptions[1]?.sessionId).toBe('omp-session-catalog');
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'omp-session-stale',
      now: 1_000,
    });

    const fresh = await start(h);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('expected fresh run');
    expect(fresh.run.metadata.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]?.sessionId).toBeUndefined();
  });

  it('persists the session identifier emitted by OMP', async () => {
    const h = await createHarness();
    h.agent.setEvents([
      { type: 'system', sessionId: 'omp-session-recorded' },
      { type: 'done', sessionId: 'omp-session-recorded', terminationReason: 'normal' },
    ]);
    const started = await start(h);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected run');
    await collect(started.run.events);

    expect(
      h.catalog.activeFor({
        scopeId: 'chat-1',
        cwdRealpath: started.run.metadata.cwdRealpath,
        policyFingerprint: started.run.metadata.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'omp-session-recorded' });
  });

  it('separates execution admission scope from resumable session scope', async () => {
    const h = await createHarness();
    const sessionScopeId = 'thread-session';
    h.workspaces.setCwd(sessionScopeId, h.tmp.workspace);
    h.agent.setEvents([
      [{ type: 'done', terminationReason: 'normal' }],
      [
        { type: 'system', sessionId: 'omp-session-persisted' },
        { type: 'done', sessionId: 'omp-session-persisted', terminationReason: 'normal' },
      ],
    ]);

    const first = await h.scopedRuns.start({
      scopeId: 'comment-run-1',
      sessionScopeId,
      scope: { source: 'im', chatId: 'oc_parent', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: sessionScopeId,
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: first.run.metadata.policyFingerprint,
      sessionId: 'omp-session-resume',
    });

    const second = await h.scopedRuns.start({
      scopeId: 'comment-run-2',
      sessionScopeId,
      scope: { source: 'im', chatId: 'oc_parent', actorId: 'ou_user' },
      prompt: 'follow up',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected second run');
    expect(second.run.metadata.resumeFrom).toBe('omp-session-resume');
    await collect(second.run.events);
    expect(
      h.catalog.activeFor({
        scopeId: sessionScopeId,
        cwdRealpath: second.run.metadata.cwdRealpath,
        policyFingerprint: second.run.metadata.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'omp-session-persisted' });
    expect(h.catalog.entries().some((entry) => entry.scopeId === 'comment-run-2')).toBe(false);
  });
});

interface ResumeHarness {
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  scopedRuns: ScopedRuns;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}

async function createHarness(): Promise<ResumeHarness> {
  const tmp = await createTmpProfile('resume-omp-test-');
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    scopedRuns: new ScopedRuns({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      sessionCatalog: catalog,
      workspaces,
      profile: 'work',
      profileConfig: () => profileConfig,
      now: () => 1_000,
    }),
    workspaces,
    catalog,
    profileConfig,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain the run so catalog persistence completes.
  }
}

async function start(h: ResumeHarness) {
  return h.scopedRuns.start({
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
  });
}
