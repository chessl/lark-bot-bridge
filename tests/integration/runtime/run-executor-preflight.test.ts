import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { SpawnFailed } from '../../../src/runtime/errors';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RunExecutor adapter startup', () => {
  it('starts the adapter after acquiring a pool slot', async () => {
    const h = await createHarness({ agent: new StartingAgent() });

    const execution = await h.executor.submit({
      scopeId: 'scope-1',
      policy: policy(h.tmp.workspace),
    });

    expect(h.agent.starts).toEqual(['run-1']);
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });
    await collect(execution.events);
  });

  it('preserves startup diagnostics and releases admission when start fails', async () => {
    const h = await createHarness({
      agent: new StartingAgent(
        new SpawnFailed('codex binary check failed', new Error('missing'), 'agent-prepare-failed'),
      ),
    });

    await expect(
      h.executor.submit({
        scopeId: 'scope-1',
        policy: policy(h.tmp.workspace),
      }),
    ).rejects.toMatchObject({ code: 'agent-prepare-failed' });
    expect(h.agent.starts).toEqual(['run-1']);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(h.activeRuns.get('scope-1')).toBeUndefined();
  });
});

async function createHarness(options: { agent: StartingAgent }): Promise<{
  tmp: TmpProfile;
  agent: StartingAgent;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  executor: RunExecutor;
}> {
  const tmp = await createTmpProfile('bridge-executor-preflight-');
  cleanups.push(tmp.cleanup);
  const pool = new ProcessPool(() => 1);
  const activeRuns = new ActiveRuns();
  return {
    tmp,
    agent: options.agent,
    pool,
    activeRuns,
    executor: new RunExecutor({
      agent: options.agent,
      pool,
      activeRuns,
      createRunId: () => 'run-1',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    }),
  };
}

class StartingAgent extends FakeAgentAdapter {
  readonly starts: string[] = [];

  constructor(private readonly startError?: Error) {
    super({ events: [{ type: 'done', terminationReason: 'normal' }] });
  }

  override async start(opts: AgentRunOptions) {
    this.starts.push(opts.runId);
    if (this.startError) throw this.startError;
    return super.start(opts);
  }
}

function policy(cwd: string): RunPolicyAllow {
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
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
