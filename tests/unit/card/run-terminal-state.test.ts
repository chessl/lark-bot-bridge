import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import {
  renderOmpReplyCard,
  renderOmpReplyMarkdown,
} from '../../../src/card/omp-reply-renderer.js';
import { initialState, type RunState, reduce } from '../../../src/card/run-state.js';
import { log } from '../../../src/core/logger.js';

function stateFrom(events: readonly AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

describe('terminal OMP Run state', () => {
  it('promotes only the last assistant message on normal completion', () => {
    const state = stateFrom([
      { type: 'final_text', content: 'earlier answer' },
      { type: 'final_text', content: 'confirmed answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    expect(state).toMatchObject({
      terminal: 'done',
      finalText: 'confirmed answer',
      reasoningEntries: ['earlier answer'],
      pendingAssistant: undefined,
    });
  });

  it('promotes translated local command output as the normal final reply', () => {
    const local = stateFrom([
      { type: 'text', delta: 'local result' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    expect(local.finalText).toBe('local result');
  });

  it.each([
    {
      name: 'interrupted',
      terminalEvent: { type: 'done', terminationReason: 'interrupted' } satisfies AgentEvent,
      terminal: 'interrupted',
      notice: '运行已中断。',
    },
    {
      name: 'idle timeout',
      terminalEvent: { type: 'done', terminationReason: 'timeout' } satisfies AgentEvent,
      terminal: 'idle_timeout',
      notice: '运行已超时。',
    },
    {
      name: 'failure',
      terminalEvent: {
        type: 'error',
        message: 'SECRET_RAW_ERROR',
        terminationReason: 'failed',
      } satisfies AgentEvent,
      terminal: 'error',
      notice: '运行失败。',
    },
  ])(
    'keeps pending text as reasoning and terminalizes open tools on $name',
    ({ terminalEvent, terminal, notice }) => {
      const state = stateFrom([
        { type: 'final_text', content: 'partial assistant text' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { secret: true } },
        terminalEvent,
      ]);
      const card = renderOmpReplyCard(state);
      const outbound = JSON.stringify(card);

      expect(state).toMatchObject({
        terminal,
        finalText: undefined,
        reasoningEntries: ['partial assistant text'],
      });
      expect(state.tools).toContainEqual(
        expect.objectContaining({ id: 'tool-1', status: 'unfinished' }),
      );
      expect(card).toMatchObject({
        config: { streaming_mode: false },
        body: {
          elements: [
            { element_id: 'reasoning', expanded: false },
            { element_id: 'answer' },
            { element_id: 'metrics' },
            { element_id: 'tools', expanded: false },
          ],
        },
      });
      expect(outbound).toContain(notice);
      expect(outbound).toContain('未完成');
      expect(outbound).not.toContain('SECRET_RAW_ERROR');
      expect(renderOmpReplyMarkdown(state)).toContain(notice);
    },
  );

  it('makes terminal state absorbing and logs ignored terminal and orphan events', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const terminal = stateFrom([
      { type: 'final_text', content: 'answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    expect(reduce(terminal, { type: 'done', terminationReason: 'normal' })).toBe(terminal);
    expect(reduce(terminal, { type: 'reasoning', content: 'too late' })).toBe(terminal);
    expect(
      reduce(initialState, { type: 'tool_result', id: 'missing', output: 'secret', isError: true }),
    ).toBe(initialState);
    expect(warn).toHaveBeenCalledWith('card', 'event-ignored', {
      reason: 'duplicate-terminal',
      type: 'done',
    });
    expect(warn).toHaveBeenCalledWith('card', 'event-ignored', {
      reason: 'post-terminal',
      type: 'reasoning',
    });
    expect(warn).toHaveBeenCalledWith('card', 'event-ignored', {
      reason: 'tool-end-without-start',
      type: 'tool_result',
    });
    warn.mockRestore();
  });

  it('renders fixed terminal Markdown and rejects running state', () => {
    const noContent = stateFrom([{ type: 'done', terminationReason: 'normal' }]);

    expect(renderOmpReplyMarkdown(noContent)).toBe(
      '**Final Reply**\n\n未返回内容\n\n_Run Termination: 已完成_\n\n_工具 0_',
    );
    expect(() => renderOmpReplyMarkdown(initialState)).toThrow('running OMP Reply');
  });
});
