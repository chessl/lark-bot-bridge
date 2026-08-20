import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, type SpawnedProcessByStdio, spawnProcess } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { type AgentAvailability, checkAgentAvailability } from '../preflight';
import {
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  CLAUDE_DEFAULT_PERMISSION_MODE,
} from '../types';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }


  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async start(opts: AgentRunOptions): Promise<AgentRun> {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.start');
    }

    // Keep bridge-only config out of argv; the temp directory is mode 0700.
    const runFiles = writeClaudeRunFiles(buildBridgeSystemPrompt(this.botIdentity), opts.nativeMcp);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      runFiles.systemPromptPath,
    ];
    if (runFiles.mcpConfigPath) args.push('--mcp-config', runFiles.mcpConfigPath);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.nativeMcp
        ? {
            env: mergeProcessEnv(process.env, {
              LARK_NATIVE_MCP_TOKEN: opts.nativeMcp.bearerToken,
            }),
          }
        : {}),
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      runFiles.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      runFiles.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(opts.prompt, 'utf8');

    // Default 5s so live subprocesses can flush state before SIGKILL.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

function writeClaudeRunFiles(
  systemPrompt: string,
  nativeMcp: AgentRunOptions['nativeMcp'],
): { systemPromptPath: string; mcpConfigPath?: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const systemPromptPath = join(dir, 'append-system-prompt.md');
  writeFileSync(systemPromptPath, systemPrompt, { encoding: 'utf8', mode: 0o600 });
  const mcpConfigPath = nativeMcp ? join(dir, 'mcp.json') : undefined;
  if (nativeMcp && mcpConfigPath) {
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [nativeMcp.name]: {
            type: 'http',
            url: nativeMcp.url,
            headers: { Authorization: `Bearer \${LARK_NATIVE_MCP_TOKEN}` },
          },
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  return {
    systemPromptPath,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}
