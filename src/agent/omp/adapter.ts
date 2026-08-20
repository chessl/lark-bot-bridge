import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { withResolvers } from '../../platform/promise';
import { mergeProcessEnv, type SpawnedProcessByStdio, spawnProcess } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import type { NativeMcpEndpoint } from '../native-tools';
import { type AgentAvailability, checkAgentAvailability } from '../preflight';
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
}

type OmpChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
interface OmpMcpPatch {
  path: string;
  endpoint: NativeMcpEndpoint;
  previousEntry: unknown;
  fileExisted: boolean;
  refs: number;
}

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';

  private readonly binary: string;
  private readonly profile: string | undefined;
  private botIdentity: AgentBotIdentity | undefined;
  private mcpPatch: OmpMcpPatch | undefined;

  constructor(opts: OmpAdapterOptions) {
    this.binary = opts.binary;
    this.profile = opts.profile;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }


  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'omp',
      agentName: 'Oh My Pi',
      command: this.binary,
      binaryPath: this.binary,
    });
  }


  async start(opts: AgentRunOptions): Promise<AgentRun> {
    if (opts.sandbox && opts.sandbox !== 'danger-full-access') {
      throw new SpawnFailed(
        'OMP currently requires full access because its RPC mode does not expose an enforceable workspace sandbox',
        undefined,
        'agent-prepare-failed',
      );
    }
    if (!opts.cwd) throw new Error('cwd is required for OmpAdapter.start');

    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));
    const releaseMcp = opts.nativeMcp ? this.acquireMcpConfig(opts.nativeMcp) : () => {};
    const args = buildOmpArgs({
      systemPromptFile: systemPromptFile.path,
      profile: this.profile,
      sessionId: opts.sessionId,
      model: opts.model,
    });
    const env: NodeJS.ProcessEnv = {};
    if (opts.nativeMcp) env.LARK_NATIVE_MCP_TOKEN = opts.nativeMcp.bearerToken;
    let child: OmpChild;
    try {
      child = spawnProcess(this.binary, args, {
        cwd: opts.cwd,
        env: mergeProcessEnv(process.env, env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as OmpChild;
    } catch (error) {
      systemPromptFile.cleanup();
      releaseMcp();
      throw error;
    }

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
    const cleanup = once(() => {
      systemPromptFile.cleanup();
      releaseMcp();
    });
    child.on('error', (err) => {
      runtimeError = err;
      cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'omp', pid: child.pid ?? null, code, signal });
      cleanup();
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

  private acquireMcpConfig(endpoint: NativeMcpEndpoint): () => void {
    if (this.mcpPatch) {
      if (
        this.mcpPatch.endpoint.url !== endpoint.url ||
        this.mcpPatch.endpoint.name !== endpoint.name
      ) {
        throw new Error('OMP MCP endpoint changed while runs are active');
      }
      this.mcpPatch.refs++;
      return once(() => this.releaseMcpConfig());
    }
    const path = ompMcpConfigPath(this.profile);
    const fileExisted = existsSync(path);
    const config = readMcpConfig(path);
    const servers = asRecord(config.mcpServers);
    const previousEntry = servers[endpoint.name];
    servers[endpoint.name] = ompMcpEntry(endpoint);
    config.mcpServers = servers;
    writeJsonAtomic(path, config);
    this.mcpPatch = { path, endpoint, previousEntry, fileExisted, refs: 1 };
    return once(() => this.releaseMcpConfig());
  }

  private releaseMcpConfig(): void {
    const patch = this.mcpPatch;
    if (!patch || --patch.refs > 0) return;
    this.mcpPatch = undefined;
    const config = readMcpConfig(patch.path);
    const servers = asRecord(config.mcpServers);
    if (
      JSON.stringify(servers[patch.endpoint.name]) !== JSON.stringify(ompMcpEntry(patch.endpoint))
    ) {
      return;
    }
    if (patch.previousEntry === undefined) delete servers[patch.endpoint.name];
    else servers[patch.endpoint.name] = patch.previousEntry;
    config.mcpServers = servers;
    if (
      !patch.fileExisted &&
      Object.keys(servers).length === 0 &&
      Object.keys(config).length === 1
    ) {
      unlinkSync(patch.path);
      return;
    }
    writeJsonAtomic(patch.path, config);
  }
}

function ompMcpConfigPath(profile: string | undefined): string {
  const activeProfile = profile ?? process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
  if (activeProfile) {
    if (!/^[A-Za-z0-9._-]+$/.test(activeProfile)) throw new Error('invalid OMP profile name');
    return join(homedir(), '.omp', 'profiles', activeProfile, 'agent', 'mcp.json');
  }
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'mcp.json');
}

function readMcpConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid OMP MCP config: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function ompMcpEntry(endpoint: NativeMcpEndpoint): Record<string, unknown> {
  return {
    type: 'http',
    url: endpoint.url,
    headers: { Authorization: `Bearer \${LARK_NATIVE_MCP_TOKEN}` },
  };
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
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
  const { promise, resolve } = withResolvers<boolean>();
  const onExit = (): void => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    child.removeListener('exit', onExit);
    resolve(false);
  }, timeoutMs);
  child.once('exit', onExit);
  return promise;
}

function waitForExitCode(child: OmpChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  const { promise, resolve } = withResolvers<number | null>();
  child.once('exit', resolve);
  return promise;
}
