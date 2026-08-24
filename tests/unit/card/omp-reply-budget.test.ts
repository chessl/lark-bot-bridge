import { describe, expect, it } from 'vitest';
import type { ImReplyPlan } from '../../../src/bot/im-invocation.js';
import {
  renderOmpReplyCard,
  renderOmpReplyMarkdown,
  renderOmpReplyMarkdownPost,
} from '../../../src/card/omp-reply-renderer.js';
import { createRunState, type RunState, type ToolEntry } from '../../../src/card/run-state.js';

const MAX_CARD_BYTES = 30 * 1024;
const TRUNCATION_MARKER = '内容过长，已截断';

function cardElementCount(card: object): number {
  function nested(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'elements' && Array.isArray(child)) {
        count += child.length;
        for (const element of child) count += nested(element);
      } else {
        count += nested(child);
      }
    }
    return count;
  }

  return ('header' in card ? 1 : 0) + nested(card);
}

function elementContent(value: unknown, elementId: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (
    'element_id' in value &&
    value.element_id === elementId &&
    'content' in value &&
    typeof value.content === 'string'
  ) {
    return value.content;
  }
  for (const child of Object.values(value)) {
    const content = elementContent(child, elementId);
    if (content !== undefined) return content;
  }
  return undefined;
}

function runningState(reasoningEntries: readonly string[]): RunState {
  return {
    ...createRunState(),
    reasoningEntries,
    reasoningTotal: reasoningEntries.length,
  };
}

function terminalState(finalText: string): RunState {
  return {
    ...createRunState(),
    terminal: 'done',
    finalText,
  };
}

function tool(id: number): ToolEntry {
  return {
    id: `tool-${id}`,
    name: `TOOL_${String(id).padStart(2, '0')}_${'🚀'.repeat(35)}`,
    action: '执行',
    status: 'done',
  };
}

describe('OMP Reply CardKit budget', () => {
  it('counts the header and nested disclosure elements at the exact 200-element edge', () => {
    const atBoundary = Array.from({ length: 98 }, (_, index) => `REASON_${index + 1}`);
    const overBoundary = [...atBoundary, 'REASON_99'];

    const exact = renderOmpReplyCard(runningState(atBoundary));
    const trimmed = renderOmpReplyCard(runningState(overBoundary));
    const outbound = JSON.stringify(trimmed);

    expect(cardElementCount(exact)).toBe(200);
    expect(cardElementCount(trimmed)).toBe(200);
    expect(outbound).not.toContain('"content":"REASON\\\\_1"');
    expect(outbound).toContain('REASON\\\\_2');
    expect(outbound).toContain('REASON\\\\_99');
    expect(outbound).toContain('中间过程（99 条）');
  });

  it('accepts the exact byte edge and truncates the next byte with the marker', () => {
    const oneByte = renderOmpReplyCard(terminalState('x'));
    const exactLength = 1 + MAX_CARD_BYTES - Buffer.byteLength(JSON.stringify(oneByte));

    const exact = renderOmpReplyCard(terminalState('x'.repeat(exactLength)));
    const over = renderOmpReplyCard(terminalState('x'.repeat(exactLength + 1)));

    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_CARD_BYTES);
    expect(elementContent(exact, 'answer')).not.toContain(TRUNCATION_MARKER);
    expect(Buffer.byteLength(JSON.stringify(over))).toBe(MAX_CARD_BYTES);
    expect(elementContent(over, 'answer')).toContain(TRUNCATION_MARKER);
  });

  it('truncates multibyte and astral text without splitting a code point', () => {
    const card = renderOmpReplyCard(terminalState('界🚀'.repeat(10_000)));
    const answer = elementContent(card, 'answer');
    const beforeMarker = answer?.slice(0, answer.indexOf(TRUNCATION_MARKER));

    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(answer).toContain(TRUNCATION_MARKER);
    expect(answer).not.toContain('�');
    expect(beforeMarker).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('budgets terminal Markdown using the serialized post envelope', () => {
    const state = terminalState('界🚀"\\\n'.repeat(10_000));
    const markdown = renderOmpReplyMarkdown(state);
    const post = renderOmpReplyMarkdownPost(state);
    const markerIndex = markdown.indexOf(TRUNCATION_MARKER);

    expect(Buffer.byteLength(JSON.stringify(post))).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(JSON.stringify(post)).toContain(TRUNCATION_MARKER);
    expect(markerIndex).toBeGreaterThan(0);
    expect(markdown).not.toContain('�');
    expect(markdown.slice(0, markerIndex)).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('budgets the final structured substitution Post with fixed Mention rows intact', () => {
    const state = terminalState('界🚀"\\\n'.repeat(10_000));
    const plan: ImReplyPlan = {
      invocationKind: 'substitution',
      reason: 'run-completed',
      scope: { kind: 'chat', id: 'oc_group', chatId: 'oc_group', mode: 'group' },
      target: { chatId: 'oc_group', messageId: 'om_source', replyInThread: false },
      senderOwnership: { kind: 'mention', openId: 'ou_sender' },
      substitutionTargetOpenIds: ['ou_target'],
      state,
    };

    const post = JSON.stringify(renderOmpReplyMarkdownPost(plan));
    expect(Buffer.byteLength(post)).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(post).toContain(TRUNCATION_MARKER);
    expect(post.match(/ou_sender/g)).toHaveLength(1);
    expect(post.match(/ou_target/g)).toHaveLength(1);
    expect(post).toContain('AI 代');
    expect(post).toContain('回答（已在本回复中点名）');
    expect(post).not.toContain('�');

    const degraded = JSON.stringify(renderOmpReplyMarkdownPost(plan, 'plain'));
    expect(Buffer.byteLength(degraded)).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(degraded).toContain(TRUNCATION_MARKER);
    expect(degraded).toContain('\\\\@请求者');
    expect(degraded).toContain('\\\\@目标');
    expect(degraded).not.toMatch(/ou_sender|ou_target|<at|"tag":"at"/);
  });

  it('removes all oldest Reasoning before oldest Tools and retains the metrics unit', () => {
    const reasoningEntries = Array.from(
      { length: 12 },
      (_, index) => `REASON_${String(index + 1).padStart(2, '0')}_${'界'.repeat(590)}`,
    );
    const tools = Array.from({ length: 20 }, (_, index) => tool(index + 1));
    const state: RunState = {
      ...terminalState('F'.repeat(28_000)),
      reasoningEntries,
      reasoningTotal: 12,
      tools,
      metrics: {
        receivedAtWall: 1_000,
        receivedAtMono: 100,
        messageCreatedAtWall: 500,
        promptSentAtMono: 200,
        firstTextAtMono: 300,
        terminalAtMono: 1_200,
        inputTokens: 1_250,
        outputTokens: 750,
        outputDurationMs: 1_500,
        outputTimingComplete: true,
        toolIds: tools.map((entry) => entry.id),
        modelId: 'gpt-budget',
        effort: 'high',
        contextPercent: 42,
      },
    };

    const card = renderOmpReplyCard(state);
    const outbound = JSON.stringify(card);
    const metricsMatches = outbound.match(/"element_id":"metrics"/g);

    expect(Buffer.byteLength(outbound)).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(outbound).not.toContain('REASON\\\\_');
    expect(outbound).not.toContain('TOOL\\\\_01');
    expect(outbound).toContain('TOOL\\\\_20');
    expect(outbound).toContain('中间过程（12 条）');
    expect(outbound).toContain('调用工具 20 次');
    expect(metricsMatches).toHaveLength(1);
    for (const metric of [
      'gpt-budget',
      'effort high',
      'ctx 42%',
      '总耗时 1.1s',
      '输入 1.3k',
      '输出 750',
      'TPS 500.0',
    ]) {
      expect(outbound).toContain(metric);
    }
    expect(outbound).not.toMatch(/飞书到达|前置|首字|OMP/);
  });
});
