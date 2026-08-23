import { describe, expect, it } from 'vitest';
import { OmpRpcFrameDecoder, OmpRpcTranslator } from '../../../src/agent/omp/rpc.js';

function translate(translator: OmpRpcTranslator, frame: unknown) {
  return [...translator.translate(frame)];
}

describe('OmpRpcFrameDecoder', () => {
  it('reassembles a negotiated v2 frame without loss', () => {
    const decoder = new OmpRpcFrameDecoder();
    const payload = Buffer.from(JSON.stringify({ type: 'command_output', output: 'hello' }));
    const split = Math.ceil(payload.length / 2);
    const first = payload.subarray(0, split).toString('base64');
    const second = payload.subarray(split).toString('base64');

    expect(
      decoder.decode(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'chunk-1',
          index: 0,
          count: 2,
          byteLength: payload.length,
          data: first,
        }),
      ),
    ).toBeUndefined();
    expect(
      decoder.decode(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'chunk-1',
          index: 1,
          count: 2,
          byteLength: payload.length,
          data: second,
        }),
      ),
    ).toEqual({ type: 'command_output', output: 'hello' });
  });

  it('rejects interrupted and oversized chunk sequences', () => {
    const decoder = new OmpRpcFrameDecoder();
    decoder.setMaxReassembledBytes(4);
    expect(() =>
      decoder.decode(
        JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'chunk-1',
          index: 0,
          count: 1,
          byteLength: 5,
          data: 'aGVsbG8=',
        }),
      ),
    ).toThrow('exceeds');
  });
});

describe('OmpRpcTranslator', () => {
  it('waits through non-terminal agent_end frames', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translate(translator, {
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'session-1' },
      }),
    ).toEqual([{ type: 'system', sessionId: 'session-1' }]);
    expect(translate(translator, { type: 'agent_end', isTerminal: false })).toEqual([]);
    expect(translate(translator, { type: 'agent_end', isTerminal: true })).toEqual([
      { type: 'done', sessionId: 'session-1', terminationReason: 'normal' },
    ]);
  });

  it('publishes only complete assistant messages after their role is known', () => {
    const translator = new OmpRpcTranslator();
    expect(translate(translator, { type: 'message_start' })).toEqual([]);
    expect(
      translate(translator, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'streamed' },
      }),
    ).toEqual([]);
    expect(
      translate(translator, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'streamed' }] },
      }),
    ).toEqual([{ type: 'final_text', content: 'streamed' }]);

    expect(translate(translator, { type: 'message_start' })).toEqual([]);
    expect(
      translate(translator, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final only' }] },
      }),
    ).toEqual([{ type: 'final_text', content: 'final only' }]);
  });

  it('discards thinking deltas and strips raw lifecycle metadata', () => {
    const translator = new OmpRpcTranslator();
    expect(
      translate(translator, {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'SECRET_THINKING' },
      }),
    ).toEqual([]);
    expect(
      translate(translator, {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'approved reasoning' }],
        },
      }),
    ).toEqual([{ type: 'reasoning', content: 'approved reasoning' }]);
    expect(
      translate(translator, {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1500,
        errorMessage: 'SECRET_ERROR',
      }),
    ).toEqual([{ type: 'retry_start', attempt: 2, maxAttempts: 3, delayMs: 1500 }]);
    expect(
      translate(translator, {
        type: 'retry_fallback_applied',
        from: 'SECRET_PROVIDER',
        to: 'SECRET_MODEL',
        role: 'SECRET_ROLE',
      }),
    ).toEqual([{ type: 'fallback_start' }]);
    expect(
      translate(translator, {
        type: 'auto_compaction_start',
        reason: 'SECRET_REASON',
        content: 'SECRET_CONTENT',
      }),
    ).toEqual([{ type: 'compaction_start' }]);
  });

  it('finishes a local-only prompt and surfaces prompt failures', () => {
    const local = new OmpRpcTranslator();
    expect(
      translate(local, {
        type: 'response',
        command: 'prompt',
        success: true,
        data: { agentInvoked: false },
      }),
    ).toEqual([{ type: 'done', terminationReason: 'normal' }]);

    const failed = new OmpRpcTranslator();
    expect(
      translate(failed, {
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'no authenticated model',
      }),
    ).toEqual([{ type: 'error', message: 'no authenticated model', terminationReason: 'failed' }]);
  });
});
