import { mkdir } from 'node:fs/promises';
import { capabilityForProfile, type AgentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { NativeToolProvider } from '../agent/native-tools';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import type { ActiveRuns } from './active-runs';
import type { ProcessPool } from './process-pool';
import type { AccessDecision } from '../policy/access';
import {
  type AgentAttachment,
  evaluateRunPolicy,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
} from '../policy/workspace';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import { RunExecutor, type RunExecution } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { WorkspaceStore } from '../workspace/store';

export interface ScopedRunsDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  nativeTools?: NativeToolProvider;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  profile: string;
  profileConfig: () => ProfileConfig;
  stopGraceMs?: () => number | undefined;
  now?: () => number;
  createRunId?: () => string;
  postDoneExitGraceMs?: number;
}

export interface StartScopedRunInput {
  scopeId: string;
  workspaceScopeId?: string;
  sessionScopeId?: string | null;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  nowait?: boolean;
  managedFallbackCwd?: string;
  observability?: {
    source: string;
    stage: string;
  };
  ttlMs?: number;
}

export interface ScopedRunMetadata {
  runId: string;
  scopeId: string;
  cwdRealpath: string;
  policyFingerprint: string;
  expiresAt: number;
  resumeFrom?: string;
  runtimeAccess: {
    label: 'access' | 'permission' | 'sandbox';
    value: string;
  };
}

export interface ScopedRun {
  readonly metadata: ScopedRunMetadata;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  wasInterrupted(): boolean;
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | 'managed-fallback-unavailable'
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export interface ScopedRunPreparedMetadata {
  cwdRealpath: string;
  runtimeAccess: ScopedRunMetadata['runtimeAccess'];
}

export class ScopedRunStartFailed extends Error {
  constructor(
    readonly metadata: ScopedRunPreparedMetadata,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ScopedRunStartFailed';
  }
}

export type StartScopedRunResult =
  | { ok: true; run: ScopedRun }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      cwdRealpath?: string;
      runtimeAccess?: ScopedRunMetadata['runtimeAccess'];
    };

export interface ScopedRunsSnapshot {
  activeScopes: string[];
  queue: { active: number; waiting: number; cap: number };
}

export class ScopedRuns {
  private readonly executor: RunExecutor;
  private readonly sessionCatalog: SessionCatalog | undefined;
  private readonly workspaces: WorkspaceStore;
  private readonly profile: string;
  private readonly activeRuns: ActiveRuns;
  private readonly pool: ProcessPool;
  private readonly profileConfig: () => ProfileConfig;
  private readonly stopGraceMs: (() => number | undefined) | undefined;
  private readonly now: () => number;
  private readonly active = new Map<string, ScopedRun>();
  private readonly activeSessionScopes = new Map<string, number>();

  constructor(deps: ScopedRunsDeps) {
    this.now = deps.now ?? Date.now;
    this.executor = new RunExecutor({
      agent: deps.agent,
      pool: deps.pool,
      activeRuns: deps.activeRuns,
      ...(deps.nativeTools ? { nativeTools: deps.nativeTools } : {}),
      ...(deps.createRunId ? { createRunId: deps.createRunId } : {}),
      ...(deps.postDoneExitGraceMs !== undefined
        ? { postDoneExitGraceMs: deps.postDoneExitGraceMs }
        : {}),
      now: this.now,
    });
    this.activeRuns = deps.activeRuns;
    this.pool = deps.pool;
    this.sessionCatalog = deps.sessionCatalog;
    this.workspaces = deps.workspaces;
    this.profile = deps.profile;
    this.profileConfig = deps.profileConfig;
    this.stopGraceMs = deps.stopGraceMs;
  }

  async start(input: StartScopedRunInput): Promise<StartScopedRunResult> {
    const profileConfig = this.profileConfig();
    const capability = capabilityForProfile(profileConfig);
    const sessionScopeId =
      input.sessionScopeId === null ? undefined : (input.sessionScopeId ?? input.scopeId);
    const workspaceScopeId = input.workspaceScopeId ?? sessionScopeId ?? input.scopeId;
    const configuredCwd = this.workspaces.cwdFor(workspaceScopeId);
    const workspace = input.managedFallbackCwd
      ? await resolveScopedWorkingDirectory(
          configuredCwd,
          profileConfig.workspaces.default,
          input.managedFallbackCwd,
        )
      : await resolveWorkingDirectory(configuredCwd ?? profileConfig.workspaces.default ?? '');
    if (!workspace.ok) {
      return {
        ok: false,
        rejectReason: {
          code: workspace.reason,
          userVisible: workspace.userVisible,
        },
      };
    }
    const requestedCwd = workspace.requestedCwd;

    const policy = evaluateRunPolicy({
      scope: input.scope,
      attachments: input.attachments,
      prompt: input.prompt,
      requestedCwd,
      cwdRealpath: workspace.cwdRealpath,
      access: input.access,
      capability,
      profileConfig,
      now: this.now(),
      codexHome: profileConfig.codex?.codexHome,
      inheritCodexHome: profileConfig.codex?.inheritCodexHome,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
    if (!policy.ok) return { ...policy, cwdRealpath: workspace.cwdRealpath };

    const runtimeAccess: ScopedRunMetadata['runtimeAccess'] =
      profileConfig.agentKind === 'claude'
        ? { label: 'permission', value: policy.permissionMode }
        : profileConfig.agentKind === 'omp'
          ? { label: 'access', value: policy.permissionMode }
          : { label: 'sandbox', value: policy.sandbox };
    const sessionScopeRun = sessionScopeId
      ? this.reserveSessionScope(sessionScopeId)
      : { wasActive: false, release() {} };
    const catalogEntry =
      sessionScopeId && !sessionScopeRun.wasActive
        ? this.sessionCatalog?.activeFor({
            scopeId: sessionScopeId,
            agentId: capability.agentId,
            cwdRealpath: workspace.cwdRealpath,
            policyFingerprint: policy.policyFingerprint,
          })
        : undefined;
    const threadId =
      catalogEntry && capability.sessionKind === 'codex-thread'
        ? catalogEntry.threadId
        : undefined;
    const sessionId =
      catalogEntry && capability.sessionKind !== 'codex-thread'
        ? catalogEntry.sessionId
        : undefined;
    const resumeFrom = threadId ?? sessionId;
    const requestedModel = resolveModelArg(
      profileConfig.agentKind,
      profileConfig.preferences.model,
    );

    let execution: RunExecution;
    try {
      execution = await this.executor.submit({
        scopeId: input.scopeId,
        policy,
        ...(sessionScopeId
          ? {
              scope: input.scope,
              allowUserIdentity:
                profileConfig.mode === 'personal' &&
                input.scope.source === 'im' &&
                input.scope.chatType === 'p2p',
            }
          : {}),
        sessionId,
        threadId,
        model: requestedModel,
        images:
          capability.agentId === 'codex' || capability.agentId === 'omp'
            ? policy.attachments
                .filter(
                  (attachment) =>
                    attachment.kind === 'image' && attachment.decision === 'accepted',
                )
                .map((attachment) => attachment.path)
                .filter((path): path is string => Boolean(path))
            : undefined,
        stopGraceMs: this.stopGraceMs?.(),
        nowait: input.nowait,
        observability: {
          profile: this.profile,
          agent: capability.agentId,
          source: input.observability?.source ?? input.scope.source,
          stage: input.observability?.stage ?? 'submit',
        },
      });
    } catch (err) {
      sessionScopeRun.release();
      if (!(err instanceof RunRejected)) {
        throw new ScopedRunStartFailed(
          { cwdRealpath: workspace.cwdRealpath, runtimeAccess },
          err,
        );
      }
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
                : '当前无法发起运行，请稍后重试。',
        },
        cwdRealpath: workspace.cwdRealpath,
        runtimeAccess,
      };
    }

    const metadata: ScopedRunMetadata = {
      runId: execution.runId,
      scopeId: input.scopeId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
      expiresAt: policy.expiresAt,
      runtimeAccess,
      ...(resumeFrom ? { resumeFrom } : {}),
    };
    let stopPromise: Promise<void> | undefined;
    let cleaned = false;
    let run: ScopedRun;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.remove(input.scopeId, run);
      sessionScopeRun.release();
    };
    const stop = (): Promise<void> => {
      stopPromise ??= execution.stop().finally(cleanup);
      return stopPromise;
    };
    run = {
      metadata,
      events: this.observe(
        execution,
        sessionScopeId,
        capability,
        policy,
        requestedModel,
        cleanup,
      ),
      stop,
      wasInterrupted: execution.wasInterrupted,
    };
    this.active.set(input.scopeId, run);
    return { ok: true, run };
  }

  interrupt(scopeId: string): boolean {
    const run = this.active.get(scopeId);
    if (!run) return false;
    void run.stop().catch((err) =>
      log.warn('run-flow', 'stop-failed', {
        scopeId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return true;
  }

  activeMetadata(
    scopeId: string,
  ): Pick<ScopedRunMetadata, 'runId' | 'policyFingerprint'> | undefined {
    const metadata = this.active.get(scopeId)?.metadata;
    return metadata
      ? { runId: metadata.runId, policyFingerprint: metadata.policyFingerprint }
      : undefined;
  }

  snapshot(): ScopedRunsSnapshot {
    return {
      activeScopes: this.activeRuns.scopes(),
      queue: this.pool.snapshot(),
    };
  }

  pauseNewRuns(reason: string): () => void {
    return this.activeRuns.pauseNewRuns(reason);
  }

  waitForAll(timeoutMs?: number): Promise<void> {
    return this.activeRuns.waitForAll(timeoutMs);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((run) => run.stop()));
  }

  private observe(
    execution: RunExecution,
    scopeId: string | undefined,
    capability: AgentCapability,
    policy: RunPolicyAllow,
    requestedModel: string | undefined,
    onDone: () => void,
  ): AsyncIterable<AgentEvent> {
    const sessionCatalog = this.sessionCatalog;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        try {
          for await (const event of execution.events) {
            if (scopeId) {
              recordRunSessionEvent({
                scopeId,
                sessionCatalog,
                capability,
                policy,
                event,
              });
              if (event.type === 'system' && event.sessionId) {
                log.info('session', 'set', { sessionId: event.sessionId });
              }
              if (event.type === 'system' && event.threadId) {
                log.info('session', 'set-thread', { threadId: event.threadId });
              }
              if (event.type === 'system' && event.model) {
                log.info('session', 'model', {
                  requested: requestedModel ?? 'default',
                  actual: event.model,
                });
              }
            }
            yield event;
          }
        } finally {
          onDone();
        }
      },
    };
  }

  private remove(scopeId: string, run: ScopedRun): void {
    if (this.active.get(scopeId) === run) this.active.delete(scopeId);
  }

  private reserveSessionScope(scopeId: string): {
    wasActive: boolean;
    release(): void;
  } {
    const count = this.activeSessionScopes.get(scopeId) ?? 0;
    this.activeSessionScopes.set(scopeId, count + 1);
    let released = false;
    return {
      wasActive: count > 0,
      release: () => {
        if (released) return;
        released = true;
        const next = (this.activeSessionScopes.get(scopeId) ?? 1) - 1;
        if (next > 0) {
          this.activeSessionScopes.set(scopeId, next);
        } else {
          this.activeSessionScopes.delete(scopeId);
        }
      },
    };
  }
}

interface RecordRunSessionEventInput {
  scopeId: string;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.capability.sessionKind !== 'codex-thread' && input.event.sessionId) {
    const cwdRealpath = input.policy.cwdRealpath;
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.sessionKind === 'codex-thread' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}

async function resolveScopedWorkingDirectory(
  configuredCwd: string | undefined,
  defaultCwd: string | undefined,
  managedFallbackCwd: string,
): Promise<
  | { ok: true; requestedCwd: string; cwdRealpath: string }
  | {
      ok: false;
      reason: WorkingDirectoryRejectReason | 'managed-fallback-unavailable';
      requestedCwd: string;
      userVisible: string;
    }
> {
  const failures: string[] = [];
  for (const requestedCwd of [configuredCwd, defaultCwd]) {
    if (!requestedCwd) continue;
    const workspace = await resolveWorkingDirectory(requestedCwd);
    if (workspace.ok) return workspace;
    failures.push(workspace.userVisible);
  }

  try {
    await mkdir(managedFallbackCwd, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      reason: 'managed-fallback-unavailable',
      requestedCwd: managedFallbackCwd,
      userVisible: [
        ...failures,
        `托管工作目录不可用：${err instanceof Error ? err.message : String(err)}`,
      ].join('；'),
    };
  }
  const workspace = await resolveWorkingDirectory(managedFallbackCwd);
  if (workspace.ok) return workspace;
  return {
    ...workspace,
    userVisible: [...failures, workspace.userVisible].join('；'),
  };
}
