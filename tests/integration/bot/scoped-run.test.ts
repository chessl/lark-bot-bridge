import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeToolProvider, NativeToolRunContext } from '../../../src/agent/native-tools';
import type { AgentEvent } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { ScopedRuns } from '../../../src/bot/run-flow';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import { SpawnFailed } from '../../../src/runtime/errors';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ScopedRuns', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await h.scopedRuns.start({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits the selected working directory through RunExecutor', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    const result = await h.scopedRuns.start({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected scoped run to start');
    expect(result.run.metadata.cwdRealpath).toBe(workspaceRealpath);
    expect(result.run.metadata.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
    });
    expect(h.scopedRuns.activeMetadata('chat-1')).toEqual({
      runId: 'run-1',
      policyFingerprint: result.run.metadata.policyFingerprint,
    });
    await collect(result.run.events);
    expect(h.scopedRuns.activeMetadata('chat-1')).toBeUndefined();
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await h.scopedRuns.start({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected scoped run to start');
    expect(result.run.metadata.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('rejects policy denial before execution admission', async () => {
    const h = await createHarness({ defaultWorkspace: true });

    const result = await start(h, 'denied', { ok: false, reason: 'denied-user' });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: { code: 'access-denied' },
    });
    expect(h.agent.runOptions).toEqual([]);
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('derives personal-DM identity access behind the seam', async () => {
    const opened: NativeToolRunContext[] = [];
    const h = await createHarness({
      defaultWorkspace: true,
      personal: true,
      nativeTools: {
        openRun(context) {
          opened.push(context);
          return {
            name: 'lark_bridge',
            url: 'http://127.0.0.1:12345/mcp',
            bearerToken: 'run-secret',
          };
        },
        closeRun: async () => {},
      },
    });

    const result = await h.scopedRuns.start({
      scopeId: 'dm-scope',
      scope: {
        source: 'im',
        chatId: 'oc_dm',
        chatType: 'p2p',
        actorId: 'ou_user',
      },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected personal DM run');
    await collect(result.run.events);

    expect(opened[0]?.allowUserIdentity).toBe(true);
  });

  it('rejects duplicate scopes, reconnect pauses, and immediate capacity without leaking', async () => {
    const h = await createHarness({
      defaultWorkspace: true,
      events: [
        [{ type: 'text', delta: 'first' }],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      poolCap: 1,
    });
    const first = await start(h, 'scope-1');
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first run');

    await expect(start(h, 'scope-1')).resolves.toMatchObject({
      ok: false,
      rejectReason: { code: 'run-already-active' },
    });
    await expect(start(h, 'scope-2', { ok: true, reason: 'allowed-user' }, true)).resolves.toMatchObject(
      {
        ok: false,
        rejectReason: { code: 'pool-full' },
      },
    );
    expect(h.pool.snapshot()).toMatchObject({ active: 1, waiting: 0 });

    await first.run.stop();
    const resume = h.activeRuns.pauseNewRuns('reconnect');
    try {
      await expect(start(h, 'scope-3')).resolves.toMatchObject({
        ok: false,
        rejectReason: { code: 'reconnect-in-progress' },
      });
    } finally {
      resume();
    }
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('releases completion, error, and stream closure promptly at the scoped seam', async () => {
    const terminalRuns: FakeAgentEvents[] = [
      [
        { type: 'done', terminationReason: 'normal' },
        { type: 'text', delta: 'must-not-be-observed' },
      ],
      [{ type: 'error', message: 'failed', terminationReason: 'failed' }],
      [],
    ];

    for (const events of terminalRuns) {
      const closed: string[] = [];
      const h = await createHarness({
        defaultWorkspace: true,
        events,
        nativeTools: nativeTools(closed),
      });
      const result = await start(h, 'scope-terminal');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected terminal run');

      const observed = await collect(result.run.events);

      expect(observed).not.toContainEqual({ type: 'text', delta: 'must-not-be-observed' });
      expect(h.activeRuns.get('scope-terminal')).toBeUndefined();
      expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
      expect(closed).toEqual(['run-1']);
    }
  });

  it('makes interruption idempotent and closes native tools once', async () => {
    const closed: string[] = [];
    const h = await createHarness({
      defaultWorkspace: true,
      events: [{ type: 'text', delta: 'running' }],
      nativeTools: nativeTools(closed),
    });
    const result = await start(h, 'scope-stop');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected interruptible run');

    await Promise.all([result.run.stop(), result.run.stop()]);

    expect(result.run.wasInterrupted()).toBe(true);
    expect(h.agent.runs[0]?.waitForExitCalls).toBe(1);
    expect(h.activeRuns.get('scope-stop')).toBeUndefined();
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(closed).toEqual(['run-1']);
  });

  it('releases reservation, capacity, and native tools after startup failure', async () => {
    const closed: string[] = [];
    const h = await createHarness({
      defaultWorkspace: true,
      agent: new ThrowingAgent(),
      nativeTools: nativeTools(closed),
    });

    await expect(start(h, 'scope-failed')).rejects.toBeInstanceOf(SpawnFailed);

    expect(h.activeRuns.get('scope-failed')).toBeUndefined();
    expect(h.pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
    expect(closed).toEqual(['run-1']);
  });
});

interface ScopedRunHarness {
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  scopedRuns: ScopedRuns;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
}

interface HarnessOptions {
  defaultWorkspace?: boolean;
  personal?: boolean;
  events?: FakeAgentEvents;
  poolCap?: number;
  agent?: FakeAgentAdapter;
  nativeTools?: NativeToolProvider;
}

async function createHarness(options: HarnessOptions = {}): Promise<ScopedRunHarness> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent =
    options.agent ??
    new FakeAgentAdapter({
      events: options.events ?? [{ type: 'done', terminationReason: 'normal' }],
    });
  const pool = new ProcessPool(() => options.poolCap ?? 1);
  const activeRuns = new ActiveRuns();
  let nextRun = 1;
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => `run-${nextRun++}`,
    now: () => 1000,
    nativeTools: options.nativeTools,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const finalConfig = {
    ...profileConfig,
    mode: options.personal ? 'personal' : profileConfig.mode,
    workspaces: {
      ...profileConfig.workspaces,
      ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
    },
  };
  cleanups.push(async () => {
    await workspaces.flush();
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    activeRuns,
    pool,
    scopedRuns: new ScopedRuns({
      executor,
      workspaces,
      profile: 'claude',
      profileConfig: () => finalConfig,
      now: () => 1000,
    }),
    workspaces,
    profileConfig: finalConfig,
  };
}

async function start(
  h: ScopedRunHarness,
  scopeId: string,
  access: { ok: true; reason: 'allowed-user' } | { ok: false; reason: 'denied-user' } = {
    ok: true,
    reason: 'allowed-user',
  },
  nowait = false,
) {
  return h.scopedRuns.start({
    scopeId,
    scope: { source: 'im', chatId: scopeId, actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access,
    nowait,
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const observed: AgentEvent[] = [];
  for await (const event of events) observed.push(event);
  return observed;
}

function nativeTools(closed: string[]): NativeToolProvider {
  return {
    openRun: () => ({
      name: 'lark_bridge',
      url: 'http://127.0.0.1:12345/mcp',
      bearerToken: 'run-secret',
    }),
    closeRun: async (runId) => {
      closed.push(runId);
    },
  };
}

class ThrowingAgent extends FakeAgentAdapter {
  override async start(): Promise<never> {
    throw new Error('startup failed');
  }
}
