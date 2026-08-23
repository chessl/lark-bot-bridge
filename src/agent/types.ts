import type { NativeMcpEndpoint } from './native-tools';
import type { AgentAvailability } from './preflight';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'thinking'; delta: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      command?: string;
      path?: string;
      query?: string;
    }
  | {
      type: 'tool_result';
      id: string;
      output: string;
      isError: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: 'retry_start';
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      error?: string;
      metadata?: unknown;
    }
  | { type: 'retry_end'; error?: string; metadata?: unknown }
  | {
      type: 'fallback_start';
      provider?: string;
      model?: string;
      role?: string;
      reason?: string;
      metadata?: unknown;
    }
  | { type: 'fallback_end'; provider?: string; model?: string; role?: string; metadata?: unknown }
  | { type: 'compaction_start'; content?: string; reason?: string; metadata?: unknown }
  | { type: 'compaction_end'; error?: string; content?: string; metadata?: unknown }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };
export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  images?: readonly string[];
  nativeMcp?: NativeMcpEndpoint;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run, allowing the agent to flush runtime state before the
   * process tree is reaped. Adapters that do not use signals may ignore it.
   */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`) to allow the
   * OMP subprocess to close cleanly before the caller falls back to stop().
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface OmpRunEngine {
  readonly id: 'omp';
  readonly displayName: 'Oh My Pi';
  checkAvailability(): Promise<AgentAvailability>;
  setBotIdentity(identity: AgentBotIdentity): void;
  start(opts: AgentRunOptions): Promise<AgentRun>;
}
