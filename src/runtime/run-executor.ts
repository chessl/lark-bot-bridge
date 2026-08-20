import { randomUUID } from 'node:crypto';
import type { NativeToolProvider } from '../agent/native-tools';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import type { ActiveRuns, RunHandle } from '../bot/active-runs';
import type { ProcessPool } from '../bot/process-pool';
import { log } from '../core/logger';
import type { RunPolicyAllow, ScopeContext } from '../policy/run-policy';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  nativeTools?: NativeToolProvider;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  scope?: ScopeContext;
  allowUserIdentity?: boolean;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  wasInterrupted(): boolean;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly nativeTools: NativeToolProvider | undefined;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.nativeTools = deps.nativeTools;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    let run: AgentRun;
    try {
      run = await this.agent.start({
        runId,
        prompt: input.policy.prompt,
        cwd: input.policy.cwdRealpath,
        sessionId: input.sessionId,
        threadId: input.threadId,
        model: input.model,
        images: input.images,
        sandbox: input.policy.sandbox,
        permissionMode: input.policy.permissionMode,
        stopGraceMs: input.stopGraceMs,
        nativeMcp:
          this.nativeTools && input.scope
            ? this.nativeTools.openRun({
                runId,
                cwd: input.policy.cwdRealpath,
                scopeId: input.scopeId,
                scope: input.scope,
                policyFingerprint: input.policy.policyFingerprint,
                allowUserIdentity: input.allowUserIdentity ?? false,
              })
            : undefined,
      });
    } catch (err) {
      release();
      releaseScope();
      await this.nativeTools?.closeRun(runId);
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent start failed', err);
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      await run.stop().catch(() => {});
      await this.nativeTools?.closeRun(runId);
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      await this.nativeTools?.closeRun(runId);
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (waitForExit: boolean): Promise<void> => {
      cleanupPromise ??= (async () => {
        this.activeRuns.unregister(input.scopeId, run);
        release();
        await this.nativeTools?.closeRun(runId);
        if (waitForExit) {
          const exited = await run.waitForExit(this.postDoneExitGraceMs);
          if (!exited) {
            log.warn('run', 'post-done-exit-timeout', {
              ...dimensions,
              graceMs: this.postDoneExitGraceMs,
            });
            await run.stop().catch((err) => {
              log.warn('run', 'post-done-stop-failed', {
                ...dimensions,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      })();
      return cleanupPromise;
    };
    const events = observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
      onDone: async () => cleanup(!handle.interrupted),
    });

    return {
      runId,
      events,
      stop: async () => {
        handle.interrupted = true;
        try {
          await run.stop();
          await run.waitForExit(this.postDoneExitGraceMs);
        } finally {
          await cleanup(false);
        }
      },
      wasInterrupted: () => handle.interrupted,
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
    onDone: () => Promise<void>;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      try {
        for await (const event of events) {
          if (event.type === 'done') {
            log.info('run', 'completed', {
              ...opts.dimensions,
              result: event.terminationReason,
              durationMs: opts.now() - opts.startedAt,
            });
            yield event;
            return;
          }
          if (event.type === 'error') {
            log.warn('run', 'failed', {
              ...opts.dimensions,
              result: event.terminationReason,
              durationMs: opts.now() - opts.startedAt,
              error: event.message,
            });
            yield event;
            return;
          }
          yield event;
        }
      } finally {
        await opts.onDone();
      }
    },
  };
}
