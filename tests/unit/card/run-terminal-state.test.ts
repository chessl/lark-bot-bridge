import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { ImReplyPlan, ImReplyReason } from '../../../src/bot/im-invocation.js';
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
  it.each([
    {
      name: 'done',
      terminal: 'done',
      finalText: 'answer <at id="ou_fake"></at>',
      reason: 'run-completed',
    },
    { name: 'empty done', terminal: 'done', reason: 'run-completed' },
    { name: 'error', terminal: 'error', reason: 'run-failed' },
    { name: 'interrupted', terminal: 'interrupted', reason: 'run-interrupted' },
    { name: 'idle timeout', terminal: 'idle_timeout', reason: 'run-timed-out' },
  ] satisfies Array<{
    name: string;
    terminal: Exclude<RunState['terminal'], 'running'>;
    finalText?: string;
    reason: ImReplyReason;
  }>)(
    'projects one sender owner through card and Post for $name',
    ({ terminal, finalText, reason }) => {
      const state: RunState = { ...initialState, terminal, ...(finalText ? { finalText } : {}) };
      const plan: ImReplyPlan = {
        invocationKind: 'ordinary',
        reason,
        scope: { kind: 'chat', id: 'oc_group', chatId: 'oc_group', mode: 'group' },
        target: { chatId: 'oc_group', messageId: 'om_source', replyInThread: false },
        senderOwnership: { kind: 'mention', openId: 'ou_sender' },
        state,
      };
      const card = JSON.stringify(renderOmpReplyCard(plan));
      const markdown = renderOmpReplyMarkdown(plan);
      const post = renderOmpReplyMarkdownPost(plan);

      expect(card.match(/ou_sender/g)).toHaveLength(1);
      expect(markdown.match(/ou_sender/g)).toHaveLength(1);
      expect(JSON.stringify(post)).toContain('"tag":"at","user_id":"ou_sender"');
      expect(JSON.stringify(post).match(/ou_sender/g)).toHaveLength(1);
      expect(card).not.toContain('ou_fake');
      expect(markdown).not.toContain('ou_fake');
      expect(JSON.stringify(post)).not.toContain('ou_fake');
    },
  );

  it.each([
    {
      name: 'done',
      terminal: 'done',
      finalText: 'answer <at id="ou_fake"></at>',
      reason: 'run-completed',
      targetMention: true,
    },
    {
      name: 'empty done',
      terminal: 'done',
      finalText: '  ',
      reason: 'run-completed',
      targetMention: false,
    },
    { name: 'error', terminal: 'error', reason: 'run-failed', targetMention: false },
    {
      name: 'interrupted',
      terminal: 'interrupted',
      reason: 'run-interrupted',
      targetMention: false,
    },
    {
      name: 'idle timeout',
      terminal: 'idle_timeout',
      reason: 'run-timed-out',
      targetMention: false,
    },
  ] satisfies Array<{
    name: string;
    terminal: Exclude<RunState['terminal'], 'running'>;
    finalText?: string;
    reason: ImReplyReason;
    targetMention: boolean;
  }>)(
    'projects substitution disclosure and target Mention only for nonempty $name',
    ({ terminal, finalText, reason, targetMention }) => {
      const state: RunState = {
        ...initialState,
        terminal,
        ...(finalText === undefined ? {} : { finalText }),
      };
      const plan: ImReplyPlan = {
        invocationKind: 'substitution',
        reason,
        scope: { kind: 'chat', id: 'oc_group', chatId: 'oc_group', mode: 'group' },
        target: { chatId: 'oc_group', messageId: 'om_source', replyInThread: false },
        senderOwnership: { kind: 'mention', openId: 'ou_sender' },
        substitutionTargets: [
          { openId: 'ou_target', displayAlias: 'Target' },
          { openId: 'ou_second', displayAlias: 'Second' },
        ],
        invalidTargetCount: 2,
        state,
      };
      const card = JSON.stringify(renderOmpReplyCard(plan));
      const markdown = renderOmpReplyMarkdown(plan);
      const post = JSON.stringify(renderOmpReplyMarkdownPost(plan));
      const degraded = JSON.stringify(renderOmpReplyMarkdownPost(plan, 'plain'));

      for (const projection of [card, markdown, post]) {
        expect(projection.match(/ou_sender/g)).toHaveLength(1);
        expect(projection.includes('ou_target')).toBe(targetMention);
        expect(projection.includes('ou_second')).toBe(targetMention);
        expect(projection.includes('AI 代')).toBe(targetMention);
        expect(projection.includes('回答（已在本回复中点名）')).toBe(targetMention);
        expect(projection.includes('另有 2 个对象身份无法确认')).toBe(targetMention);
        expect(projection).not.toContain('ou_fake');
      }
      expect(post.match(/ou_target/g) ?? []).toHaveLength(targetMention ? 1 : 0);
      expect(post.match(/ou_second/g) ?? []).toHaveLength(targetMention ? 1 : 0);
      expect(degraded).not.toMatch(/ou_sender|ou_target|ou_second|<at|"tag":"at"/);
      expect(degraded).toContain('\\\\@请求者');
      expect(degraded.includes('\\\\@Target')).toBe(targetMention);
      expect(degraded.includes('\\\\@Second')).toBe(targetMention);
      expect(degraded.includes('回答（已在本回复中点名）')).toBe(targetMention);
      expect(degraded).toContain('Mention 不可用');
    },
  );

  it('keeps Progress Reply free of ownership Mention', () => {
    const progress: RunState = {
      ...initialState,
      reasoningEntries: ['<at id="ou_sender"></at> waiting'],
      reasoningTotal: 1,
    };
    expect(JSON.stringify(renderOmpReplyCard(progress))).not.toMatch(/<at|ou_sender|请求者/);
  });
});
