import { afterEach, describe, expect, it } from 'vitest';
import type { NativeToolProvider, NativeToolRunContext } from '../../../src/agent/native-tools';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunRejected, SpawnFailed } from '../../../src/runtime/errors';
import { RunExecutor } from '../../../src/runtime/run-executor';
import {
  FakeAgentAdapter,
  type FakeAgentEvents,
  type FakeAgentRun,
} from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RunExecutor', () => {
  it('generates one runId and wires it through adapter, record, and active runs', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
      stopGraceMs: 123,
    });

    expect(execution.runId).toBe('run-1');
    expect(execution.run.runId).toBe('run-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      prompt: 'hello',
      cwd: h.tmp.workspace,
      sandbox: 'read-only',
      permissionMode: 'plan',
      stopGraceMs: 123,
    });
    expect(h.activeRuns.get('scope-1')?.run.runId).toBe('run-1');

    await collect(execution.events);
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('opens one run-scoped native endpoint and closes it after the run', async () => {
    const opened: NativeToolRunContext[] = [];
    const closed: string[] = [];
    const nativeTools: NativeToolProvider = {
      openRun(context) {
        opened.push(context);
        return {
          name: 'lark_bridge',
          url: 'http://127.0.0.1:12345/mcp',
          bearerToken: 'run-secret',
        };
      },
      async closeRun(runId) {
        closed.push(runId);
      },
    };
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
      nativeTools,
    });
    const scope = {
      source: 'im' as const,
      chatId: 'oc_1',
      chatType: 'p2p' as const,
      messageId: 'om_1',
      actorId: 'ou_1',
    };

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      scope,
      allowUserIdentity: true,
      policy: policy(h.tmp.workspace),
    });

    expect(opened).toEqual([
      {
        runId: 'run-1',
        cwd: h.tmp.workspace,
        scopeId: 'scope-1',
        scope,
        policyFingerprint: 'fp',
        allowUserIdentity: true,
      },
    ]);
    expect(h.agent.runOptions[0]?.nativeMcp).toEqual({
      name: 'lark_bridge',
      url: 'http://127.0.0.1:12345/mcp',
      bearerToken: 'run-secret',
    });
    await collect(execution.events);
    expect(closed).toEqual(['run-1']);
  });

  it('fast-fails nowait when the pool is full and queues normal submissions FIFO', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-nowait',
        policy: policy(h.tmp.workspace),
        nowait: true,
      }),
    ).rejects.toMatchObject({ code: 'pool-full' });

    const secondPromise = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    await collect(first.events);
    const second = await secondPromise;
    expect(second.runId).toBe('run-2');
    await collect(second.events);
  });

  it('rejects expired policy before spawning the adapter', async () => {
    const h = await createHarness({ events: [] });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace, { expiresAt: 999 }),
      }),
    ).rejects.toBeInstanceOf(RunRejected);
    expect(h.agent.runs).toHaveLength(0);
  });

  it('rejects new submissions while reconnect is draining active runs', async () => {
    const h = await createHarness({ events: [] });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(
        h.executor.submit({
          scopeId: 'scope-1',
          policy: policy(h.tmp.workspace),
        }),
      ).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('rejects duplicate submissions for a scope that already has a run', async () => {
    const h = await createHarness({ events: [{ type: 'done', terminationReason: 'normal' }] });

    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toMatchObject({ code: 'run-already-active' });
    expect(h.agent.runs).toHaveLength(1);

    await collect(first.events);
  });

  it('accepts new submissions after reconnect drain is released', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    resume();

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    expect(execution.runId).toBe('run-1');
    await collect(execution.events);
  });

  it('rejects submissions that were queued before reconnect drain started', async () => {
    const h = await createHarness({
      events: [
        [{ type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    const second = h.executor.submit({
      scopeId: 'scope-2',
      policy: policy(h.tmp.workspace),
    });
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await collect(first.events);
      await expect(second).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(h.agent.runs).toHaveLength(1);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('rejects submissions paused while prepareRun is still pending', async () => {
    const agent = new DelayedPrepareAgent({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const h = await createHarness({ agent });

    const submit = h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });
    await agent.prepareStarted;

    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      agent.releasePrepare();
      await expect(submit).rejects.toMatchObject({ code: 'reconnect-in-progress' });
      expect(agent.runs).toHaveLength(0);
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    } finally {
      resume();
    }
  });

  it('releases pool and active run state when adapter spawn fails', async () => {
    const h = await createHarness({ agent: new ThrowingAgent() });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toBeInstanceOf(SpawnFailed);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });

  it('stops and waits for the underlying run when execution is interrupted', async () => {
    const h = await createHarness({
      events: [{ type: 'text', delta: 'running' }],
      waitForExit: true,
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await execution.stop();

    const run = execution.run as FakeAgentRun;
    expect(run.stopped).toBe(true);
    expect(run.waitForExitCalls).toBe(1);
  });

  it('stops the underlying process when it does not exit after a terminal event', async () => {
    const h = await createHarness({
      events: [{ type: 'done', terminationReason: 'normal' }],
      waitForExit: false,
    });
    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    await collect(execution.events);

    const run = execution.run as FakeAgentRun;
    expect(run.waitForExitCalls).toBe(1);
    expect(run.stopped).toBe(true);
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });
});

async function createHarness(options: {
  events?: FakeAgentEvents;
  waitForExit?: boolean | readonly boolean[];
  poolCap?: number;
  agent?: AgentAdapter;
  nativeTools?: NativeToolProvider;
}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
}> {
  const tmp = await createTmpProfile('bridge-executor-');
  cleanups.push(tmp.cleanup);
  let nextRun = 1;
  const agent =
    options.agent ??
    new FakeAgentAdapter({
      events: options.events ?? [],
      waitForExit: options.waitForExit,
    });
  const pool = new ProcessPool(() => options.poolCap ?? 2);
  const activeRuns = new ActiveRuns();
  return {
    tmp,
    agent: agent as FakeAgentAdapter,
    pool,
    activeRuns,
    executor: new RunExecutor({
      agent,
      pool,
      activeRuns,
      createRunId: () => `run-${nextRun++}`,
      now: () => 1000,
      postDoneExitGraceMs: 10,
      nativeTools: options.nativeTools,
    }),
  };
}

function policy(cwd: string, overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: cwd,
    cwdRealpath: cwd,
    accessMode: 'read-only',
    sandbox: 'read-only',
    permissionMode: 'plan',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

class ThrowingAgent implements AgentAdapter {
  readonly id = 'throwing';
  readonly displayName = 'Throwing';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(_opts: AgentRunOptions): AgentRun {
    throw new Error('spawn failed');
  }
}

class DelayedPrepareAgent extends FakeAgentAdapter {
  readonly prepareStarted: Promise<void>;
  private resolvePrepareStarted!: () => void;
  private resolvePrepare!: () => void;

  constructor(options: ConstructorParameters<typeof FakeAgentAdapter>[0]) {
    super(options);
    this.prepareStarted = new Promise((resolve) => {
      this.resolvePrepareStarted = resolve;
    });
  }

  async prepareRun(): Promise<void> {
    this.resolvePrepareStarted();
    await new Promise<void>((resolve) => {
      this.resolvePrepare = resolve;
    });
  }

  releasePrepare(): void {
    this.resolvePrepare();
  }
}
