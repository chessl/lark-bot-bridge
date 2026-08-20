import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import {
  type AgentKind,
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware run-flow resume', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes Claude only when scope, agent, cwd, and policy fingerprint match', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.run.events);

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: first.run.metadata.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.run.metadata.resumeFrom).toBe('sess-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'sess-catalog',
      threadId: undefined,
    });
  });

  it('resumes Codex threads from the catalog', async () => {
    const h = await createHarness('codex');
    const probe = await start(h);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error('expected probe run');
    await collect(probe.run.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: probe.run.metadata.cwdRealpath,
      policyFingerprint: probe.run.metadata.policyFingerprint,
      threadId: 'thread-catalog',
      now: 1000,
    });

    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.run.metadata.resumeFrom).toBe('thread-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: 'thread-catalog',
    });
  });

  it('resumes OMP sessions through the agent-aware catalog', async () => {
    const h = await createHarness('omp');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial OMP run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'omp',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: first.run.metadata.policyFingerprint,
      sessionId: 'omp-session-catalog',
      now: 1000,
    });

    const resumed = await start(h);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed OMP run');
    expect(resumed.run.metadata.resumeFrom).toBe('omp-session-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'omp-session-catalog',
      threadId: undefined,
    });
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness('claude');
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.run.metadata.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('persists system session identifiers while callers only observe events', async () => {
    const claude = await createHarness('claude');
    claude.agent.setEvents([
      { type: 'system', sessionId: 'sess-recorded' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const claudeRun = await start(claude);
    expect(claudeRun.ok).toBe(true);
    if (!claudeRun.ok) throw new Error('expected claude run');
    await collect(claudeRun.run.events);

    expect(
      claude.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: claudeRun.run.metadata.cwdRealpath,
        policyFingerprint: claudeRun.run.metadata.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });

    const codex = await createHarness('codex');
    codex.agent.setEvents([
      { type: 'system', threadId: 'thread-recorded' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const codexRun = await start(codex);
    expect(codexRun.ok).toBe(true);
    if (!codexRun.ok) throw new Error('expected codex run');
    await collect(codexRun.run.events);

    expect(
      codex.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: codexRun.run.metadata.cwdRealpath,
        policyFingerprint: codexRun.run.metadata.policyFingerprint,
      }),
    ).toMatchObject({ threadId: 'thread-recorded' });
  });
  it('separates execution admission scope from workspace and resumable session scope', async () => {
    const h = await createHarness('claude');
    const sessionScopeId = 'thread-session';
    h.workspaces.setCwd(sessionScopeId, h.tmp.workspace);
    h.agent.setEvents([
      [{ type: 'done', terminationReason: 'normal' }],
      [
        { type: 'system', sessionId: 'sess-persisted' },
        { type: 'done', terminationReason: 'normal' },
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
    if (!first.ok) throw new Error('expected first scoped run');
    await collect(first.run.events);
    h.catalog.upsertActive({
      scopeId: sessionScopeId,
      agentId: 'claude',
      cwdRealpath: first.run.metadata.cwdRealpath,
      policyFingerprint: first.run.metadata.policyFingerprint,
      sessionId: 'sess-resume',
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
    if (!second.ok) throw new Error('expected second scoped run');
    expect(second.run.metadata.resumeFrom).toBe('sess-resume');
    expect(h.agent.runOptions[1]?.sessionId).toBe('sess-resume');
    await collect(second.run.events);

    expect(
      h.catalog.activeFor({
        scopeId: sessionScopeId,
        agentId: 'claude',
        cwdRealpath: second.run.metadata.cwdRealpath,
        policyFingerprint: second.run.metadata.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-persisted' });
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

async function createHarness(agentKind: AgentKind): Promise<ResumeHarness> {
  const tmp = await createTmpProfile(`resume-${agentKind}-test-`);
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind,
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
    ...(agentKind === 'omp' ? { omp: { binaryPath: '/usr/local/bin/omp' } } : {}),
  });
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
      profile: agentKind,
      profileConfig: () => profileConfig,
      now: () => 1000,
    }),
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: tmp.workspace,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
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
