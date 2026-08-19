import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilityForProfile,
  claudeCapability,
  codexCapability,
} from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  recordRunSessionEvent,
  startRunFlow,
  type StartRunFlowInput,
} from '../../../src/bot/run-flow.js';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
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
    await collect(first.execution.events);

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.resumeFrom).toBe('sess-catalog');
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
    await collect(probe.execution.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'codex',
      cwdRealpath: probe.cwdRealpath,
      policyFingerprint: probe.policy.policyFingerprint,
      threadId: 'thread-catalog',
      now: 1000,
    });

    const resumed = await start(h);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed run');
    expect(resumed.resumeFrom).toBe('thread-catalog');
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
    await collect(first.execution.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'omp',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'omp-session-catalog',
      now: 1000,
    });

    const resumed = await start(h);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected resumed OMP run');
    expect(resumed.resumeFrom).toBe('omp-session-catalog');
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
    await collect(first.execution.events);
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'claude',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('records system session identifiers into the agent-aware catalog', async () => {
    const claude = await createHarness('claude');
    const claudeRun = await start(claude);
    expect(claudeRun.ok).toBe(true);
    if (!claudeRun.ok) throw new Error('expected claude run');
    await collect(claudeRun.execution.events);

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessionCatalog: claude.catalog,
      capability: claudeCapability(claude.profileConfig),
      policy: claudeRun.policy,
      event: { type: 'system', sessionId: 'sess-recorded', cwd: claudeRun.cwdRealpath },
    });

    expect(
      claude.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'claude',
        cwdRealpath: claudeRun.cwdRealpath,
        policyFingerprint: claudeRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });

    const codex = await createHarness('codex');
    const codexRun = await start(codex);
    expect(codexRun.ok).toBe(true);
    if (!codexRun.ok) throw new Error('expected codex run');
    await collect(codexRun.execution.events);

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessionCatalog: codex.catalog,
      capability: codexCapability(codex.profileConfig),
      policy: codexRun.policy,
      event: { type: 'system', threadId: 'thread-recorded' },
    });

    expect(
      codex.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'codex',
        cwdRealpath: codexRun.cwdRealpath,
        policyFingerprint: codexRun.policy.policyFingerprint,
      }),
    ).toMatchObject({ threadId: 'thread-recorded' });
  });
});

async function createHarness(agentKind: AgentKind): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
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
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
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

async function start(h: Awaited<ReturnType<typeof createHarness>>) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability: capabilityForProfile(h.profileConfig),
    profileConfig: h.profileConfig,
    sessionCatalog: h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  } satisfies StartRunFlowInput & { sessionCatalog: SessionCatalog };
  return startRunFlow(input);
}
