import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import {
  renderOmpReplyCard,
  renderOmpReplyMarkdown,
  renderOmpReplyMarkdownPost,
} from '../../../src/card/omp-reply-renderer.js';
import { initialState, type RunState, reduce } from '../../../src/card/run-state.js';
import { log } from '../../../src/core/logger.js';

function stateFrom(events: readonly AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

const REPLY_MENTION_OPEN_ID = 'ou_reply_user';

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

  it('keeps multiline final Markdown unwrapped', () => {
    const finalText = '可以。\n\n- 第一项\n- 第二项';
    const card = renderOmpReplyCard(
      stateFrom([
        { type: 'final_text', content: finalText },
        { type: 'done', terminationReason: 'normal' },
      ]),
    );

    expect(card).toMatchObject({
      body: {
        elements: [{ element_id: 'answer', content: finalText }],
      },
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

  it.each([
    {
      name: 'done',
      events: [
        { type: 'final_text', content: 'answer' },
        { type: 'done', terminationReason: 'normal' },
      ] satisfies readonly AgentEvent[],
    },
    {
      name: 'empty done',
      events: [{ type: 'done', terminationReason: 'normal' }] satisfies readonly AgentEvent[],
    },
    {
      name: 'interrupted',
      events: [{ type: 'done', terminationReason: 'interrupted' }] satisfies readonly AgentEvent[],
    },
    {
      name: 'idle timeout',
      events: [{ type: 'done', terminationReason: 'timeout' }] satisfies readonly AgentEvent[],
    },
    {
      name: 'error',
      events: [
        { type: 'error', message: 'failed', terminationReason: 'failed' },
      ] satisfies readonly AgentEvent[],
    },
  ])('appends one recipient Mention after every $name presentation', ({ events }) => {
    const state = stateFrom(events);
    const card = renderOmpReplyCard(state, {
      streamingMode: false,
      replyMentionOpenId: REPLY_MENTION_OPEN_ID,
    });
    const post = renderOmpReplyMarkdownPost(state, REPLY_MENTION_OPEN_ID);

    expect(card).toMatchObject({
      body: {
        elements: [
          { element_id: 'answer' },
          {
            element_id: 'reply-mention',
            content: `<at id="${REPLY_MENTION_OPEN_ID}"></at>`,
          },
        ],
      },
    });
    expect(JSON.stringify(card).match(/"element_id":"reply-mention"/g)).toHaveLength(1);
    expect(post).toMatchObject({
      zh_cn: {
        content: [[{ tag: 'md' }], [{ tag: 'at', user_id: REPLY_MENTION_OPEN_ID }]],
      },
    });
  });

  it('never includes the terminal recipient Mention in a running card', () => {
    const card = renderOmpReplyCard(initialState, {
      streamingMode: true,
      replyMentionOpenId: REPLY_MENTION_OPEN_ID,
    });

    expect(JSON.stringify(card)).not.toContain(REPLY_MENTION_OPEN_ID);
  });
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

  it('keeps harness branding out of running cards', () => {
    const card = renderOmpReplyCard(initialState);
    const outbound = JSON.stringify(card);

    expect(card).toMatchObject({ header: { title: { content: '正在处理' } } });
    expect(outbound).toContain('回复会在确认后原位出现');
    expect(outbound).not.toMatch(/OMP|Final Reply|Run Termination/);
  });

  it('omits empty terminal details and renders fixed Markdown', () => {
    const noContent = stateFrom([{ type: 'done', terminationReason: 'normal' }]);
    const card = renderOmpReplyCard(noContent);
    const outbound = JSON.stringify(card);

    expect(outbound).not.toContain('"subtitle"');
    expect(card).toMatchObject({
      header: { title: { content: '回复' } },
      body: {
        elements: [{ element_id: 'answer', content: '未返回内容' }],
      },
    });
    expect(outbound).not.toContain('"element_id":"reasoning"');
    expect(outbound).not.toContain('"element_id":"tools"');
    expect(outbound).not.toMatch(/工具 0|OMP/);
    expect(renderOmpReplyMarkdown(noContent)).toBe('**回复**\n\n未返回内容\n\n_状态: 已完成_');
    expect(() => renderOmpReplyMarkdown(initialState)).toThrow('running OMP Reply');
  });
});
