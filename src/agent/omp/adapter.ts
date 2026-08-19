import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { OmpRpcFrameDecoder, OmpRpcTranslator } from './rpc';

export interface OmpAdapterOptions {
  binary: string;
  profile?: string;
  larkChannel?: LarkChannelEnvContext;
}

type OmpChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';

  private readonly binary: string;
  private readonly profile: string | undefined;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OmpAdapterOptions) {
    this.binary = opts.binary;
    this.profile = opts.profile;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'omp',
      agentName: 'Oh My Pi',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(opts: AgentRunOptions): Promise<void> {
    if (opts.sandbox && opts.sandbox !== 'danger-full-access') {
      throw new SpawnFailed(
        'OMP currently requires full access because its RPC mode does not expose an enforceable workspace sandbox',
        undefined,
        'agent-prepare-failed',
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for OmpAdapter.run');

    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));
    const args = buildOmpArgs({
      systemPromptFile: systemPromptFile.path,
      profile: this.profile,
      sessionId: opts.sessionId,
      model: opts.model,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OmpChild;

    log.info('agent', 'spawn', {
      agent: 'omp',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const text = chunk.toString('utf8').trim();
      if (text) log.warn('agent', 'stderr', { agent: 'omp', line: text.slice(0, 1000) });
    });
    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'omp', pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { agent: 'omp', message: err.message });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;
    return {
      runId: opts.runId,
      events: createEventStream(child, opts, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        writeFrame(child, { id: `abort-${opts.runId}`, type: 'abort' });
        child.stdin.end();
        if (await waitForExit(child, stopGraceMs)) return;
        child.kill('SIGTERM');
        if (await waitForExit(child, stopGraceMs)) return;
        child.kill('SIGKILL');
        await waitForExit(child, stopGraceMs);
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExit(child, timeoutMs);
      },
    };
  }
}

export function buildOmpArgs(input: {
  systemPromptFile: string;
  profile?: string;
  sessionId?: string;
  model?: string;
}): string[] {
  return [
    '--mode',
    'rpc',
    '--no-title',
    '--approval-mode',
    'yolo',
    '--append-system-prompt',
    input.systemPromptFile,
    ...(input.profile ? ['--profile', input.profile] : []),
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ...(input.model ? ['--model', input.model] : []),
  ];
}

async function* createEventStream(
  child: OmpChild,
  opts: AgentRunOptions,
  stderrChunks: Buffer[],
  getRuntimeError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  const decoder = new OmpRpcFrameDecoder();
  const translator = new OmpRpcTranslator();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const negotiateId = `protocol-${opts.runId}`;
  const stateId = `state-${opts.runId}`;
  const promptId = `prompt-${opts.runId}`;
  let started = false;

  const startPrompt = (): void => {
    if (started) return;
    started = true;
    writeFrame(child, { id: stateId, type: 'get_state' });
    writeFrame(child, {
      id: promptId,
      type: 'prompt',
      message: opts.prompt,
      ...(opts.images?.length ? { images: opts.images.map(readImage) } : {}),
    });
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const frame = decoder.decode(line);
      if (frame === undefined || !frame || typeof frame !== 'object' || Array.isArray(frame))
        continue;
      const rpcFrame = frame as Record<string, unknown>;

      if (rpcFrame.type === 'ready') {
        decoder.setMaxReassembledBytes(rpcFrame.maxReassembledFrameBytes);
        const supported = Array.isArray(rpcFrame.supportedProtocolVersions)
          ? rpcFrame.supportedProtocolVersions
          : [];
        if (supported.includes(2)) {
          writeFrame(child, {
            id: negotiateId,
            type: 'negotiate_protocol',
            protocolVersion: 2,
          });
        } else {
          startPrompt();
        }
        continue;
      }

      if (
        rpcFrame.type === 'response' &&
        rpcFrame.id === negotiateId &&
        rpcFrame.command === 'negotiate_protocol' &&
        rpcFrame.success === true
      ) {
        startPrompt();
      }

      if (rpcFrame.type === 'extension_ui_request') {
        const method = rpcFrame.method;
        const id = rpcFrame.id;
        if (
          typeof id === 'string' &&
          (method === 'select' ||
            method === 'confirm' ||
            method === 'input' ||
            method === 'editor' ||
            method === 'open_url')
        ) {
          writeFrame(child, { type: 'extension_ui_response', id, cancelled: true });
        }
        continue;
      }

      for (const event of translator.translate(rpcFrame)) {
        if (event.type === 'done' || event.type === 'error') child.stdin.end();
        yield event;
        if (event.type === 'done' || event.type === 'error') return;
      }
    }
  } catch (err) {
    child.stdin.end();
    yield* translator.fail(
      `OMP RPC stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const exitCode = await waitForExitCode(child);
  if (translator.terminalEmitted()) return;
  const runtimeError = getRuntimeError();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
  if (runtimeError) {
    yield* translator.fail(`OMP runtime error: ${runtimeError.message}`);
  } else if (exitCode !== 0) {
    yield* translator.fail(`OMP exited with code ${exitCode ?? 'unknown'}${detail}`);
  } else {
    yield* translator.fail('OMP RPC stream ended before a terminal event');
  }
}

function writeFrame(child: OmpChild, frame: Record<string, unknown>): void {
  if (child.stdin.destroyed || child.stdin.writableEnded) return;
  child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8');
}

function readImage(path: string): { type: 'image'; data: string; mimeType: string } {
  return {
    type: 'image',
    data: readFileSync(path).toString('base64'),
    mimeType: mimeTypeForPath(path),
  };
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-channel-omp-'));
  const path = join(dir, 'APPEND_SYSTEM.md');
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function waitForExit(child: OmpChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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
}

function waitForExitCode(child: OmpChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
