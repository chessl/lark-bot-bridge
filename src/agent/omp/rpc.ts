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
  private sawTextInMessage = false;
  private terminal = false;

  terminalEmitted(): boolean {
    return this.terminal;
  }

  *translate(frame: unknown): Generator<AgentEvent> {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    const rpcFrame = frame as Record<string, unknown>;
    if (typeof rpcFrame.type !== 'string') return;

    if (rpcFrame.type === 'response') {
      yield* this.translateResponse(rpcFrame);
      return;
    }

    if (rpcFrame.type === 'message_start') {
      this.sawTextInMessage = false;
      return;
    }

    if (rpcFrame.type === 'message_update') {
      const rawUpdate = rpcFrame.assistantMessageEvent;
      const update =
        rawUpdate && typeof rawUpdate === 'object' && !Array.isArray(rawUpdate)
          ? (rawUpdate as Record<string, unknown>)
          : undefined;
      const delta = stringField(update, 'delta');
      if (update?.type === 'text_delta' && delta !== undefined) {
        this.sawTextInMessage = true;
        yield { type: 'text', delta };
      } else if (update?.type === 'thinking_delta' && delta !== undefined) {
        yield { type: 'thinking', delta };
      }
      return;
    }

    if (rpcFrame.type === 'message_end') {
      const rawMessage = rpcFrame.message;
      const message =
        rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
          ? (rawMessage as Record<string, unknown>)
          : undefined;
      if (!this.sawTextInMessage && message?.role === 'assistant') {
        const text = assistantText(message.content);
        if (text) {
          this.sawTextInMessage = true;
          yield { type: 'text', delta: text };
        }
      }
      const usage = usageEvent(message?.usage);
      if (usage) yield usage;
      this.sawTextInMessage = false;
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
      }
      return;
    }

    if (rpcFrame.type === 'command_output') {
      const text = resultText(rpcFrame.output ?? rpcFrame.content ?? rpcFrame.message);
      if (text) {
        yield { type: 'text', delta: text };
      }
      return;
    }

    if (rpcFrame.type === 'prompt_result' && rpcFrame.agentInvoked === false) {
      yield* this.finish();
      return;
    }

    if (rpcFrame.type === 'agent_end') {
      const usage = usageEvent(rpcFrame.usage);
      if (usage) yield usage;
      if (rpcFrame.isTerminal !== false) yield* this.finish();
      return;
    }

  }

  *fail(message: string, terminationReason: 'failed' | 'interrupted' | 'timeout' = 'failed'): Generator<AgentEvent> {
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
      const modelRecord =
        rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)
          ? (rawModel as Record<string, unknown>)
          : undefined;
      const provider = stringField(modelRecord, 'provider');
      const modelId = stringField(modelRecord, 'id');
      const model = provider && modelId ? `${provider}/${modelId}` : modelId;
      yield {
        type: 'system',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(model ? { model } : {}),
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
        yield* this.finish();
      }
    }
  }

  private *finish(): Generator<AgentEvent> {
    if (this.terminal) return;
    this.terminal = true;
    yield {
      type: 'done',
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      terminationReason: 'normal',
    };
  }
}

function usageEvent(value: unknown): Extract<AgentEvent, { type: 'usage' }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const rawCost = usage.cost;
  const cost =
    rawCost && typeof rawCost === 'object' && !Array.isArray(rawCost)
      ? (rawCost as Record<string, unknown>)
      : undefined;
  const event: Extract<AgentEvent, { type: 'usage' }> = {
    type: 'usage',
    inputTokens: numberField(usage, 'inputTokens') ?? numberField(usage, 'input'),
    outputTokens: numberField(usage, 'outputTokens') ?? numberField(usage, 'output'),
    cachedInputTokens:
      numberField(usage, 'cachedInputTokens') ?? numberField(usage, 'cacheRead'),
    reasoningOutputTokens: numberField(usage, 'reasoningOutputTokens'),
    costUsd: numberField(usage, 'costUsd') ?? numberField(cost, 'total'),
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
