import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

interface ChunkFrame {
  type: 'rpc_chunk';
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface PendingChunks {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
}

export class OmpRpcFrameDecoder {
  private maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
  private pending: PendingChunks | undefined;

  setMaxReassembledBytes(value: unknown): void {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      this.maxReassembledBytes = value;
    }
  }

  decode(line: string): unknown | undefined {
    const frame = JSON.parse(line) as unknown;
    if (!isChunkFrame(frame)) {
      if (this.pending) throw new Error('OMP RPC chunk sequence was interrupted');
      return frame;
    }

    if (frame.count < 1 || frame.index < 0 || frame.index >= frame.count) {
      throw new Error('OMP RPC chunk metadata is invalid');
    }
    if (frame.byteLength < 0 || frame.byteLength > this.maxReassembledBytes) {
      throw new Error('OMP RPC reassembled frame exceeds the advertised limit');
    }
    if (!isBase64(frame.data)) throw new Error('OMP RPC chunk data is not valid base64');

    if (!this.pending) {
      if (frame.index !== 0) throw new Error('OMP RPC chunk sequence did not start at index 0');
      this.pending = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
      };
    }

    const pending = this.pending;
    if (
      frame.chunkId !== pending.id ||
      frame.count !== pending.count ||
      frame.byteLength !== pending.byteLength ||
      frame.index !== pending.parts.length
    ) {
      throw new Error('OMP RPC chunk sequence is inconsistent');
    }

    pending.parts.push(Buffer.from(frame.data, 'base64'));
    if (pending.parts.length !== pending.count) return undefined;

    this.pending = undefined;
    const payload = Buffer.concat(pending.parts);
    if (payload.byteLength !== pending.byteLength) {
      throw new Error('OMP RPC chunk byte length does not match its declaration');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  }
}

export class OmpRpcTranslator {
  private sessionId: string | undefined;
  private assistantDraft = '';
  private commandOutput = '';
  private textStarted = false;
  private commandTextStarted = false;
  private terminal = false;

  terminalEmitted(): boolean {
    return this.terminal;
  }

  *translate(frame: unknown): Generator<AgentEvent> {
    if (this.terminal) {
      log.info('agent', 'rpc-frame-ignored', {
        reason: 'post-terminal',
        type: frameType(frame),
      });
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      log.warn('agent', 'rpc-frame-ignored', { reason: 'malformed' });
      return;
    }
    const rpcFrame = frame as Record<string, unknown>;
    if (typeof rpcFrame.type !== 'string') {
      log.warn('agent', 'rpc-frame-ignored', { reason: 'malformed' });
      return;
    }

    if (rpcFrame.type === 'response') {
      yield* this.translateResponse(rpcFrame);
      return;
    }

    if (rpcFrame.type === 'message_start') {
      this.assistantDraft = '';
      return;
    }

    if (rpcFrame.type === 'message_update') {
      const rawUpdate = rpcFrame.assistantMessageEvent;
      const update =
        rawUpdate && typeof rawUpdate === 'object' && !Array.isArray(rawUpdate)
          ? (rawUpdate as Record<string, unknown>)
          : undefined;
      const delta = stringField(update, 'delta');
      if (update?.type === 'text_delta' && delta) {
        this.assistantDraft += delta;
        if (!this.textStarted) {
          this.textStarted = true;
          yield { type: 'text_started' };
        }
      }
      // thinking_delta is deliberately discarded. Only complete, structured
      // reasoning content from message_end is eligible for user projection.
      return;
    }

    if (rpcFrame.type === 'message_end') {
      const rawMessage = rpcFrame.message;
      const message =
        rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
          ? (rawMessage as Record<string, unknown>)
          : undefined;
      if (message?.role === 'assistant') {
        const text = assistantText(message.content) || this.assistantDraft;
        if (text) yield { type: 'final_text', content: text };
        for (const content of explicitReasoning(message.content)) {
          yield { type: 'reasoning', content };
        }
        const usage = usageEvent(message);
        if (usage) yield usage;
      }
      this.assistantDraft = '';
      return;
    }

    if (rpcFrame.type === 'tool_execution_start') {
      const id = stringField(rpcFrame, 'toolCallId') ?? stringField(rpcFrame, 'id');
      const name = stringField(rpcFrame, 'toolName') ?? stringField(rpcFrame, 'name');
      if (id && name) {
        yield {
          type: 'tool_use',
          id,
          name,
          input: rpcFrame.args ?? rpcFrame.arguments ?? {},
        };
      } else {
        log.warn('agent', 'rpc-frame-ignored', {
          reason: 'malformed',
          type: rpcFrame.type,
        });
      }
      return;
    }

    if (rpcFrame.type === 'tool_execution_end') {
      const id = stringField(rpcFrame, 'toolCallId') ?? stringField(rpcFrame, 'id');
      if (id) {
        yield {
          type: 'tool_result',
          id,
          output: resultText(rpcFrame.result ?? rpcFrame.output),
          isError: rpcFrame.isError === true || rpcFrame.error === true,
        };
      } else {
        log.warn('agent', 'rpc-frame-ignored', {
          reason: 'malformed',
          type: rpcFrame.type,
        });
      }
      return;
    }

    if (rpcFrame.type === 'auto_retry_start') {
      yield {
        type: 'retry_start',
        attempt: numberField(rpcFrame, 'attempt'),
        maxAttempts: numberField(rpcFrame, 'maxAttempts'),
        delayMs: numberField(rpcFrame, 'delayMs'),
      };
      return;
    }

    if (rpcFrame.type === 'auto_retry_end') {
      yield { type: 'retry_end' };
      return;
    }

    if (rpcFrame.type === 'retry_fallback_applied') {
      yield { type: 'fallback_start' };
      return;
    }

    if (rpcFrame.type === 'retry_fallback_succeeded') {
      yield { type: 'fallback_end' };
      return;
    }

    if (rpcFrame.type === 'auto_compaction_start') {
      yield { type: 'compaction_start' };
      return;
    }

    if (rpcFrame.type === 'auto_compaction_end') {
      yield { type: 'compaction_end' };
      return;
    }

    if (rpcFrame.type === 'command_output') {
      const output = resultText(rpcFrame.output ?? rpcFrame.content ?? rpcFrame.message);
      this.commandOutput += output;
      if (output && !this.commandTextStarted) {
        this.commandTextStarted = true;
        yield { type: 'command_text_started' };
      }
      return;
    }

    if (rpcFrame.type === 'prompt_result') {
      if (rpcFrame.agentInvoked === false) yield* this.finish(false);
      return;
    }

    if (rpcFrame.type === 'agent_end') {
      if (rpcFrame.isTerminal !== false) yield* this.finish(true);
      return;
    }

    if (rpcFrame.type === 'agent_start') return;

    log.warn('agent', 'rpc-frame-ignored', {
      reason: 'unknown',
      type: rpcFrame.type,
    });
  }

  *fail(
    message: string,
    terminationReason: 'failed' | 'interrupted' | 'timeout' = 'failed',
  ): Generator<AgentEvent> {
    if (this.terminal) return;
    this.terminal = true;
    yield { type: 'error', message, terminationReason };
  }

  private *translateResponse(frame: Record<string, unknown>): Generator<AgentEvent> {
    const command = stringField(frame, 'command');
    if (frame.success === false) {
      if (command === 'prompt' || command === 'get_state' || command === 'negotiate_protocol') {
        const error = stringField(frame, 'error') ?? `OMP RPC ${command ?? 'command'} failed`;
        yield* this.fail(error);
      }
      return;
    }

    if (command === 'get_state') {
      const rawData = frame.data;
      const data =
        rawData && typeof rawData === 'object' && !Array.isArray(rawData)
          ? (rawData as Record<string, unknown>)
          : undefined;
      const sessionId = stringField(data, 'sessionId');
      if (sessionId) this.sessionId = sessionId;
      const rawModel = data?.model;
      const model =
        rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)
          ? (rawModel as Record<string, unknown>)
          : undefined;
      const rawContextUsage = data?.contextUsage;
      const contextUsage =
        rawContextUsage && typeof rawContextUsage === 'object' && !Array.isArray(rawContextUsage)
          ? (rawContextUsage as Record<string, unknown>)
          : undefined;
      const modelId = stringField(model, 'id');
      const effort = stringField(data, 'thinkingLevel');
      const contextPercent = numberField(contextUsage, 'percent');
      yield {
        type: 'system',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(effort ? { effort } : {}),
        ...(contextPercent !== undefined ? { contextPercent } : {}),
      };
      return;
    }

    if (command === 'prompt') {
      const rawData = frame.data;
      if (
        rawData &&
        typeof rawData === 'object' &&
        !Array.isArray(rawData) &&
        (rawData as Record<string, unknown>).agentInvoked === false
      ) {
        yield* this.finish(false);
      }
    }
  }

  private *finish(agentInvoked: boolean): Generator<AgentEvent> {
    if (this.terminal) return;
    this.terminal = true;
    const localOutput = agentInvoked ? '' : this.commandOutput;
    this.commandOutput = '';
    if (localOutput) yield { type: 'text', delta: localOutput, source: 'command' };
    yield {
      type: 'done',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      terminationReason: 'normal',
    };
  }
}

function frameType(frame: unknown): string {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'malformed';
  const type = (frame as Record<string, unknown>).type;
  return typeof type === 'string' ? type : 'malformed';
}

function usageEvent(
  message: Record<string, unknown>,
): Extract<AgentEvent, { type: 'usage' }> | undefined {
  const value = message.usage;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const durationMs = numberField(message, 'duration');
  const ttftMs = numberField(message, 'ttft');
  const outputDurationMs =
    durationMs !== undefined && ttftMs !== undefined && ttftMs >= 0 && durationMs > ttftMs
      ? durationMs - ttftMs
      : undefined;
  const event: Extract<AgentEvent, { type: 'usage' }> = {
    type: 'usage',
    inputTokens: numberField(usage, 'inputTokens') ?? numberField(usage, 'input'),
    outputTokens: numberField(usage, 'outputTokens') ?? numberField(usage, 'output'),
    cacheReadTokens:
      numberField(usage, 'cacheReadTokens') ??
      numberField(usage, 'cachedInputTokens') ??
      numberField(usage, 'cacheRead'),
    cacheWriteTokens: numberField(usage, 'cacheWriteTokens') ?? numberField(usage, 'cacheWrite'),
    ...(outputDurationMs !== undefined ? { outputDurationMs } : {}),
  };
  return Object.values(event).some((entry) => typeof entry === 'number') ? event : undefined;
}

function assistantText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const content = part as Record<string, unknown>;
      if (content.type !== 'text') return '';
      return stringField(content, 'text') ?? '';
    })
    .join('');
}

function explicitReasoning(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const content = part as Record<string, unknown>;
    if (content.type !== 'thinking') return [];
    const reasoning = stringField(content, 'thinking');
    return reasoning ? [reasoning] : [];
  });
}

function resultText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
          return stringField(part as Record<string, unknown>, 'text') ?? '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function isChunkFrame(value: unknown): value is ChunkFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === 'rpc_chunk' &&
    typeof frame.chunkId === 'string' &&
    typeof frame.index === 'number' &&
    Number.isInteger(frame.index) &&
    typeof frame.count === 'number' &&
    Number.isInteger(frame.count) &&
    typeof frame.byteLength === 'number' &&
    Number.isSafeInteger(frame.byteLength) &&
    typeof frame.data === 'string'
  );
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
