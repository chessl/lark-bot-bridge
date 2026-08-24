import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type * as LarkChannelModule from '@larksuite/channel';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { OmpReplyController } from '../../../src/bot/omp-reply-controller.js';
import { createRunState, type RunState } from '../../../src/card/run-state.js';
import type { Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof LarkChannelModule>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (message: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  handlers: MessageHandlerMap;
  operations: string[];
  createdCards: object[];
  updates: Array<{ cardId: string; card: object; sequence: number }>;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  streams: unknown[];
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: Mock<(...args: unknown[]) => Promise<unknown>>;
    application: {
      v6: { application: { get: Mock<(...args: unknown[]) => Promise<unknown>> } };
    };
    im: {
      v1: {
        message: {
          get: Mock<(...args: unknown[]) => Promise<unknown>>;
          reply: Mock<(input: unknown) => Promise<unknown>>;
        };
        messageReaction: {
          create: Mock<(...args: unknown[]) => Promise<unknown>>;
          delete: Mock<(...args: unknown[]) => Promise<unknown>>;
        };
      };
    };
    cardkit: {
      v1: {
        card: {
          update: Mock<(input: unknown) => Promise<unknown>>;
          settings: Mock<(input: unknown) => Promise<unknown>>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(card: object): Promise<{ cardId: string }>;
  updateCardById(cardId: string, card: object, sequence: number): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

interface EventGate {
  after: number;
  promise: Promise<void>;
  reached?: () => void;
}

function controllableEventGate(after: number) {
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  return {
    after,
    promise: release.promise,
    resolve: release.resolve,
    reached: reached.resolve,
    reachedPromise: reached.promise,
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const ambiguousInitialReplies = [
  {
    name: 'timeout',
    reply: async () => {
      throw new Error('request timed out');
    },
  },
  {
    name: 'disconnect',
    reply: async () => {
      throw new Error('socket disconnected');
    },
  },
  { name: '5xx', reply: async () => ({ status: 503 }) },
  { name: 'missing receipt', reply: async () => ({ code: 0, data: {} }) },
  { name: 'rate limit', reply: async () => ({ status: 429 }) },
] as const;

describe('P2P OMP Reply', () => {
  it('opens before prompt consumption, finalizes the same bubble, then closes streaming', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'FINAL_REPLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_trigger', 'run'));
    await waitFor(() =>
      h.channel.operations.some((operation) => operation.startsWith('card:close:')),
    );

    expect(h.channel.operations.indexOf('im:reply')).toBeLessThan(
      h.channel.operations.indexOf('omp:consume'),
    );
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_trigger' },
        data: expect.objectContaining({ msg_type: 'interactive', reply_in_thread: false }),
      }),
    );
    const replyCall = h.channel.rawClient.im.v1.message.reply.mock.calls[0]?.[0];
    expect(replyCardId(replyCall)).toBe('card_1');
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);

    const finalUpdate = h.channel.updates.at(-1);
    expect(h.channel.updates.every((update) => update.cardId === 'card_1')).toBe(true);
    expect(finalUpdate?.cardId).toBe('card_1');
    expect(JSON.stringify(finalUpdate?.card)).toContain('FINAL_REPLY_SENTINEL');
    expect(finalUpdate?.card).toMatchObject({ config: { streaming_mode: true } });

    const closeCall = h.channel.rawClient.cardkit.v1.card.settings.mock.calls.at(-1)?.[0];
    expect(closeCall).toMatchObject({
      path: { card_id: 'card_1' },
      data: { sequence: (finalUpdate?.sequence ?? 0) + 1 },
    });
    expect(JSON.parse(closeSettings(closeCall))).toMatchObject({ streaming_mode: false });
    expect(h.channel.operations.indexOf(`card:update:${finalUpdate?.sequence}`)).toBeLessThan(
      h.channel.operations.indexOf(`card:close:${(finalUpdate?.sequence ?? 0) + 1}`),
    );

    const reactionCreate = h.channel.rawClient.im.v1.messageReaction.create;
    expect(reactionCreate).toHaveBeenNthCalledWith(1, {
      path: { message_id: 'om_trigger' },
      data: { reaction_type: { emoji_type: 'OnIt' } },
    });
    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith({
      path: { message_id: 'om_trigger', reaction_id: 'reaction_1' },
    });
    expect(reactionCreate).toHaveBeenNthCalledWith(2, {
      path: { message_id: 'om_trigger' },
      data: { reaction_type: { emoji_type: 'Done' } },
    });
    expect(h.channel.operations.indexOf('reaction:add:OnIt')).toBeLessThan(
      h.channel.operations.indexOf('im:reply'),
    );
    expect(h.channel.operations.indexOf('reaction:delete:reaction_1')).toBeLessThan(
      h.channel.operations.indexOf('reaction:add:Done'),
    );
  });

  it.each([
    {
      name: 'normal completion',
      events: [
        { type: 'final_text', content: 'EARLIER_ASSISTANT' },
        { type: 'final_text', content: 'CONFIRMED_FINAL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      expectedAnswer: 'CONFIRMED_FINAL',
      expectedReasoning: 'EARLIER\\\\_ASSISTANT',
    },
    {
      name: 'local-only completion',
      events: [
        { type: 'text', delta: 'LOCAL_COMMAND_RESULT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      expectedAnswer: 'LOCAL_COMMAND_RESULT',
    },
    {
      name: 'no-content completion',
      events: [],
      expectedAnswer: '未返回内容',
    },
    {
      name: 'interruption',
      events: [
        { type: 'final_text', content: 'PARTIAL_INTERRUPTED' },
        { type: 'tool_use', id: 'tool-interrupted', name: 'Bash', input: {} },
        { type: 'done', terminationReason: 'interrupted' },
      ],
      expectedAnswer: '运行已中断。',
      expectedReasoning: 'PARTIAL\\\\_INTERRUPTED',
      unfinishedTool: true,
    },
    {
      name: 'idle timeout',
      events: [
        { type: 'final_text', content: 'PARTIAL_TIMEOUT' },
        { type: 'tool_use', id: 'tool-timeout', name: 'Bash', input: {} },
        { type: 'done', terminationReason: 'timeout' },
      ],
      expectedAnswer: '运行已超时。',
      expectedReasoning: 'PARTIAL\\\\_TIMEOUT',
      unfinishedTool: true,
    },
    {
      name: 'failure',
      events: [
        { type: 'final_text', content: 'PARTIAL_FAILURE' },
        { type: 'tool_use', id: 'tool-failed', name: 'Bash', input: {} },
        {
          type: 'error',
          message: 'SECRET_RAW_FAILURE',
          terminationReason: 'failed',
        },
      ],
      expectedAnswer: '运行失败。',
      expectedReasoning: 'PARTIAL\\\\_FAILURE',
      unfinishedTool: true,
    },
  ] satisfies readonly {
    name: string;
    events: FakeAgentEvents;
    expectedAnswer: string;
    expectedReasoning?: string;
    unfinishedTool?: boolean;
  }[])(
    'terminalizes $name in the original Reply before closing',
    async ({ events, expectedAnswer, expectedReasoning, unfinishedTool }) => {
      const h = await createHarness({ events });
      const expectedSummary =
        expectedAnswer === '运行失败。'
          ? '失败'
          : expectedAnswer === '运行已中断。'
            ? '已中断'
            : expectedAnswer === '运行已超时。'
              ? '已超时'
              : '已完成';
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_terminal_${expectedAnswer}`, 'run'));
      await waitFor(() =>
        h.channel.operations.some((operation) => operation.startsWith('card:close:')),
      );
      await waitFor(() => h.channel.operations.includes('reaction:delete:reaction_1'));

      expect(h.channel.createdCards).toHaveLength(1);
      expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
      expect(replyCardId(h.channel.rawClient.im.v1.message.reply.mock.calls[0]?.[0])).toBe(
        'card_1',
      );
      expect(h.channel.sent).toHaveLength(0);
      expect(h.channel.streams).toHaveLength(0);

      const finalUpdate = h.channel.updates.at(-1);
      expect(finalUpdate?.cardId).toBe('card_1');
      expect(h.channel.updates.every((update) => update.cardId === 'card_1')).toBe(true);
      const elements = cardElements(finalUpdate?.card);
      expect(elements).toMatchObject([
        ...(expectedReasoning ? [{ element_id: 'reasoning', expanded: false }] : []),
        { element_id: 'answer', content: `**${expectedAnswer}**` },
        { element_id: 'metrics' },
        ...(unfinishedTool ? [{ element_id: 'tools', expanded: false }] : []),
      ]);
      const outbound = JSON.stringify(finalUpdate?.card);
      if (expectedReasoning) expect(outbound).toContain(expectedReasoning);
      if (unfinishedTool) expect(outbound).toContain('未完成');
      expect(outbound).not.toContain('SECRET_RAW_FAILURE');

      const closeCall = h.channel.rawClient.cardkit.v1.card.settings.mock.calls.at(-1)?.[0];
      const closeSequence = (finalUpdate?.sequence ?? 0) + 1;
      expect(operationSequence(closeCall)).toBe(closeSequence);
      expect(JSON.parse(closeSettings(closeCall))).toMatchObject({
        summary: { content: expectedSummary },
      });
      expect(h.channel.operations.indexOf(`card:update:${finalUpdate?.sequence}`)).toBeLessThan(
        h.channel.operations.indexOf(`card:close:${closeSequence}`),
      );
      const reactionTypes =
        h.channel.rawClient.im.v1.messageReaction.create.mock.calls.map(reactionEmojiType);
      expect(reactionTypes).toEqual(expectedSummary === '已完成' ? ['OnIt', 'Done'] : ['OnIt']);
      expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledOnce();
    },
  );

  it('projects ordered progress without disclosing hidden OMP fields', async () => {
    const progressGates = [2, 3, 4, 5, 6, 12].map(controllableEventGate);
    const hidden = [
      'SECRET_THINKING',
      'SECRET_TOOL_INPUT',
      'SECRET_COMMAND',
      'SECRET_PATH',
      'SECRET_QUERY',
      'SECRET_TOOL_OUTPUT',
      'SECRET_TOOL_RESULT',
      'SECRET_TOOL_ERROR',
      'SECRET_RETRY_ERROR',
      'SECRET_RETRY_METADATA',
      'SECRET_FALLBACK_PROVIDER',
      'SECRET_FALLBACK_MODEL',
      'SECRET_FALLBACK_ROLE',
      'SECRET_FALLBACK_REASON',
      'SECRET_FALLBACK_METADATA',
      'SECRET_COMPACTION_CONTENT',
      'SECRET_COMPACTION_REASON',
      'SECRET_COMPACTION_METADATA',
      'SECRET_COMPACTION_ERROR',
      'SECRET_ORPHAN_OUTPUT',
    ];
    const h = await createHarness({
      events: [
        { type: 'thinking', delta: hidden[0] ?? '' },
        {
          type: 'retry_start',
          attempt: 2,
          maxAttempts: 3,
          delayMs: 1500,
          error: hidden[8],
          metadata: hidden[9],
        },
        {
          type: 'fallback_start',
          provider: hidden[10],
          model: hidden[11],
          role: hidden[12],
          reason: hidden[13],
          metadata: hidden[14],
        },
        {
          type: 'compaction_start',
          content: hidden[15],
          reason: hidden[16],
          metadata: hidden[17],
        },
        { type: 'compaction_end', error: hidden[18] },
        { type: 'fallback_end', provider: hidden[10], model: hidden[11], role: hidden[12] },
        { type: 'retry_end', error: hidden[8] },
        {
          type: 'tool_result',
          id: 'missing-tool',
          output: hidden[19] ?? '',
          isError: true,
        },
        { type: 'final_text', content: 'INTERMEDIATE_ASSISTANT' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: {
            arguments: hidden[1],
            command: hidden[2],
            path: hidden[3],
            query: hidden[4],
          },
          command: hidden[2],
          path: hidden[3],
          query: hidden[4],
        },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { input: hidden[1] },
        },
        {
          type: 'tool_result',
          id: 'tool-1',
          output: hidden[5] ?? '',
          result: hidden[6],
          error: hidden[7],
          isError: false,
        },
        { type: 'reasoning', content: 'EXPLICIT_RPC_REASONING' },
        { type: 'final_text', content: 'FIRST_ASSISTANT' },
        { type: 'final_text', content: 'SECOND_ASSISTANT' },
        { type: 'final_text', content: 'SAFE_FINAL_REPLY' },
        { type: 'done', terminationReason: 'normal' },
      ],
      eventGates: progressGates,
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_safe_progress', 'run'));
    await vi.waitFor(() => expect(h.channel.operations).toContain('omp:consume'));
    for (const [index, gate] of progressGates.entries()) {
      await gate.reachedPromise;
      await vi.runAllTimersAsync();
      expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledTimes(index + 1);
      gate.resolve();
    }
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );

    const payloads = [
      ...h.channel.createdCards,
      ...h.channel.updates.map((update) => update.card),
    ].map((card) => JSON.stringify(card));
    const outbound = payloads.join('\n');
    for (const secret of hidden) expect(outbound).not.toContain(secret);
    expect(outbound).toContain('INTERMEDIATE\\\\_ASSISTANT');
    expect(outbound).toContain('EXPLICIT\\\\_RPC\\\\_REASONING');
    expect(outbound).toContain('FIRST\\\\_ASSISTANT');
    expect(outbound).toContain('SECOND\\\\_ASSISTANT');
    expect(outbound).toContain('SAFE_FINAL_REPLY');
    expect(outbound).toContain('等待重试（2/3，1.5s）');
    expect(outbound).toContain('正在切换备用模型');
    expect(outbound).toContain('正在整理上下文');
    expect(payloads.filter((payload) => payload.includes('等待重试（2/3，1.5s）')).length).toBe(2);
    expect(payloads.filter((payload) => payload.includes('正在切换备用模型')).length).toBe(2);

    const running = h.channel.updates.findLast((update) =>
      JSON.stringify(update.card).includes('"content":"运行中"'),
    )?.card;
    const elements = cardElements(running);
    expect(elements[0]).toMatchObject({
      tag: 'collapsible_panel',
      element_id: 'reasoning',
      expanded: true,
      header: {
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' },
        icon_position: 'right',
      },
    });
    expect(elements[0]).not.toHaveProperty('border');
    expect(elements[1]).toMatchObject({ element_id: 'answer' });
    expect(elements.at(-1)).toMatchObject({
      tag: 'collapsible_panel',
      element_id: 'tools',
      expanded: true,
    });
    expect(elements.at(-1)).not.toHaveProperty('border');
    expect(JSON.stringify(elements.at(-1))).toContain('调用工具 1 次');
    expect(JSON.stringify(elements.at(-1))).toContain('运行操作');
    expect(JSON.stringify(elements.at(-1))).toContain('执行');
    expect(JSON.stringify(elements.at(-1))).toContain('完成');
  });

  it('captures the 12/13 Reasoning and 20/21 Tools boundaries with cumulative totals', async () => {
    const events: FakeAgentEvents = [
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'reasoning' as const,
        content: `REASON_${String(index + 1).padStart(2, '0')}_END`,
      })),
      { type: 'reasoning', content: 'X'.repeat(650) },
      { type: 'tool_use', id: 'tool-01', name: 'Read', input: {} },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: 'tool_use' as const,
        id: `tool-${String(index + 2).padStart(2, '0')}`,
        name: 'Bash',
        input: {},
      })),
      { type: 'done', terminationReason: 'normal' },
    ];
    const reasoningBoundary = controllableEventGate(12);
    const toolsBoundary = controllableEventGate(33);
    const overflowBoundary = controllableEventGate(34);
    const h = await createHarness({
      events,
      eventGates: [reasoningBoundary, toolsBoundary, overflowBoundary],
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_bounded_progress', 'run'));
    await vi.waitFor(() => expect(h.channel.operations).toContain('omp:consume'));
    await reasoningBoundary.reachedPromise;
    await vi.runAllTimersAsync();
    const twelve = h.channel.updates.at(-1)?.card;

    reasoningBoundary.resolve();
    await toolsBoundary.reachedPromise;
    await vi.runAllTimersAsync();
    const twenty = h.channel.updates.at(-1)?.card;

    toolsBoundary.resolve();
    await overflowBoundary.reachedPromise;
    await vi.runAllTimersAsync();
    const overflow = h.channel.updates.at(-1)?.card;

    expect(JSON.stringify(twelve)).toContain('REASON\\\\_01\\\\_END');
    expect(JSON.stringify(twelve)).toContain('REASON\\\\_12\\\\_END');
    expect(JSON.stringify(twelve)).not.toContain('REASON\\\\_13\\\\_END');
    expect(JSON.stringify(twelve)).toContain('中间过程（12 条）');

    const twentyOutbound = JSON.stringify(twenty);
    expect(twentyOutbound).not.toContain('REASON\\\\_01\\\\_END');
    expect(twentyOutbound).toContain('REASON\\\\_02\\\\_END');
    expect(twentyOutbound).toContain('中间过程（13 条）');
    expect(twentyOutbound).toContain(`${'X'.repeat(599)}…`);
    expect(twentyOutbound.match(/运行操作/g)).toHaveLength(19);
    expect(twentyOutbound).toContain('读取信息');
    expect(twentyOutbound).toContain('调用工具 20 次');

    const overflowOutbound = JSON.stringify(overflow);
    expect(overflowOutbound).not.toContain('读取信息');
    expect(overflowOutbound.match(/运行操作/g)).toHaveLength(20);
    expect(overflowOutbound).toContain('调用工具 21 次');
    for (const card of [twelve, twenty, overflow]) {
      expect(totalCardElements(card)).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(30 * 1024);
    }

    overflowBoundary.resolve();
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );
  });

  it('captures exact 200-element and would-be 201-element controller projections', async () => {
    const reasoningEntries = Array.from({ length: 98 }, (_, index) => `REASON_${index + 1}`);
    const exactState: RunState = {
      ...createRunState(),
      reasoningEntries,
      reasoningTotal: reasoningEntries.length,
    };
    const overState: RunState = {
      ...exactState,
      metrics: { ...exactState.metrics, modelId: 'gpt-element-boundary' },
    };
    const exactChannel = createFakeLarkChannel();
    const overChannel = createFakeLarkChannel();
    const target = {
      chatId: 'oc_element_budget',
      messageId: 'om_element_budget',
      replyInThread: false,
    } as const;

    await new OmpReplyController({
      channel: exactChannel as unknown as LarkChannel,
      target,
    }).open(exactState);
    await new OmpReplyController({
      channel: overChannel as unknown as LarkChannel,
      target,
    }).open(overState);

    const exact = exactChannel.createdCards[0];
    const over = overChannel.createdCards[0];
    const overOutbound = JSON.stringify(over);

    expect(totalCardElements(exact)).toBe(200);
    expect(JSON.stringify(exact)).not.toContain('"element_id":"metrics"');
    expect(totalCardElements(exact) + 1).toBe(201);
    expect(totalCardElements(over)).toBe(199);
    expect(overOutbound).toContain('"element_id":"metrics"');
    expect(overOutbound).not.toContain('"content":"REASON\\\\_1"');
    expect(overOutbound).toContain('REASON\\\\_2');
    expect(overOutbound).toContain('中间过程（98 条）');
    expect(exactChannel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(overChannel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
  });

  it('captures an exact 30 KB terminal card with metrics, marker, and one IM Reply', async () => {
    const h = await createHarness({
      wallNow: clock(1_000_500),
      monoNow: clock(100, 2_600, 3_850, 125_100),
      events: [
        { type: 'prompt_sent' },
        {
          type: 'system',
          modelId: 'gpt-budget',
          effort: 'high',
          contextPercent: 7.25,
        },
        { type: 'text_started' },
        { type: 'tool_use', id: 'tool-budget', name: 'read', input: {} },
        { type: 'final_text', content: `界🚀${'x'.repeat(40_000)}` },
        {
          type: 'usage',
          inputTokens: 900,
          cacheReadTokens: 50,
          cacheWriteTokens: 25,
          outputTokens: 999,
        },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_budget', 'run', 1_000_000));
    await waitFor(() =>
      h.channel.operations.some((operation) => operation.startsWith('card:close:')),
    );

    const finalCard = h.channel.updates.at(-1)?.card;
    const outbound = JSON.stringify(finalCard);
    const metrics = cardElements(finalCard).filter(
      (element) => 'element_id' in element && element.element_id === 'metrics',
    );
    const answer = cardElements(finalCard).find(
      (element) => 'element_id' in element && element.element_id === 'answer',
    );

    expect(Buffer.byteLength(outbound)).toBe(30 * 1024);
    expect(answer).toMatchObject({
      content: expect.stringContaining('界🚀'),
    });
    expect(answer).toMatchObject({
      content: expect.stringContaining('内容过长，已截断'),
    });
    expect(JSON.stringify(answer)).not.toContain('�');
    expect(metrics).toHaveLength(1);
    for (const metric of [
      'gpt-budget',
      'effort high',
      'ctx 7.3%',
      '总耗时 2m5s',
      '输入 975',
      '输出 999',
      'TPS 8.2',
    ]) {
      expect(JSON.stringify(metrics)).toContain(metric);
    }
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(h.channel.sent).toHaveLength(0);
  });

  it.each(ambiguousInitialReplies)(
    'exact-retries an ambiguous initial IM Reply ($name), then fails closed',
    async ({ reply }) => {
      const h = await createHarness({
        events: [
          { type: 'text', delta: 'MUST_NOT_BE_CONSUMED' },
          { type: 'done', terminationReason: 'normal' },
        ],
        reply,
      });
      await startTestBridge(h);
      vi.useFakeTimers();

      void h.channel.handlers.message?.(message('om_ambiguous', 'run'));
      await vi.waitFor(() =>
        expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce(),
      );
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

      const attempts = h.channel.rawClient.im.v1.message.reply.mock.calls.map(([input]) =>
        JSON.stringify(input),
      );
      expect(attempts).toHaveLength(3);
      expect(attempts).toEqual([attempts[0], attempts[0], attempts[0]]);
      expect(h.channel.createdCards).toHaveLength(1);
      expect(h.channel.updates).toHaveLength(0);
      expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
      expect(h.channel.sent).toHaveLength(0);
      expect(h.channel.streams).toHaveLength(0);
      expect(h.channel.operations).not.toContain('omp:consume');
    },
  );

  it('does not retry a business rejection before changing transport', async () => {
    const h = await createHarness({
      reply: async () => ({ code: 99991400, msg: 'permission denied' }),
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_rejected', 'run'));
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledTimes(3);
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ msg_type: 'interactive' }) }),
    );
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ msg_type: 'interactive' }) }),
    );
    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ data: expect.objectContaining({ msg_type: 'post' }) }),
    );
    expect(h.channel.operations).toContain('omp:consume');
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('accepts 200780 only as exact-retry binding proof and keeps one bubble', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'BOUND_REPLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      reply: async () => ({ code: 200780 }),
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_bound', 'run'));
    await vi.waitFor(() => expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce());
    await vi.runAllTimersAsync();
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );

    const attempts = h.channel.rawClient.im.v1.message.reply.mock.calls.map(([input]) =>
      JSON.stringify(input),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.updates.at(-1)?.cardId).toBe('card_1');
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);
  });

  it('retries the exact final update before the next-sequence close', async () => {
    let updateAttempt = 0;
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'EXACT_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      update: async () => {
        updateAttempt++;
        if (updateAttempt === 1) throw new Error('socket disconnected');
        return { code: 0 };
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_update_retry', 'run'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );

    const updateCalls = h.channel.rawClient.cardkit.v1.card.update.mock.calls.map(
      ([input]) => input,
    );
    expect(updateCalls).toHaveLength(2);
    expect(JSON.stringify(updateCalls[1])).toBe(JSON.stringify(updateCalls[0]));
    expect(operationSequence(updateCalls[0])).toBe(1);
    const closeCall = h.channel.rawClient.cardkit.v1.card.settings.mock.calls[0]?.[0];
    expect(operationSequence(closeCall)).toBe(2);
    expect(h.channel.operations).toEqual(expect.arrayContaining(['card:update:1', 'card:close:2']));
    expect(h.channel.operations.lastIndexOf('card:update:1')).toBeLessThan(
      h.channel.operations.indexOf('card:close:2'),
    );
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('exact-retries streaming close without changing its sequence or summary payload', async () => {
    let closeAttempt = 0;
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'CLOSE_RETRY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      close: async () => {
        closeAttempt++;
        if (closeAttempt === 1) return { status: 503 };
        return { code: 0 };
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_close_retry', 'run'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledTimes(2),
    );

    const closeCalls = h.channel.rawClient.cardkit.v1.card.settings.mock.calls.map(
      ([input]) => input,
    );
    expect(JSON.stringify(closeCalls[1])).toBe(JSON.stringify(closeCalls[0]));
    expect(operationSequence(closeCalls[0])).toBe(2);
    expect(h.channel.updates.map((update) => update.sequence)).toEqual([1]);
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('coalesces running projections latest-wins and skips an identical projection', async () => {
    const burstGate = controllableEventGate(2);
    const identicalGate = controllableEventGate(3);
    const h = await createHarness({
      events: [
        { type: 'reasoning', content: 'OLDERPROJECTION' },
        { type: 'reasoning', content: 'LATESTPROJECTIONSENTINEL' },
        {
          type: 'tool_result',
          id: 'missing-tool',
          output: 'IGNORED_OUTPUT',
          isError: false,
        },
        { type: 'done', terminationReason: 'normal' },
      ] satisfies readonly AgentEvent[],
      eventGates: [burstGate, identicalGate],
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_latest', 'run'));
    await vi.waitFor(() => expect(h.channel.operations).toContain('omp:consume'));
    await burstGate.reachedPromise;
    await vi.runAllTimersAsync();
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.channel.updates[0]?.card)).toContain('LATESTPROJECTIONSENTINEL');

    burstGate.resolve();
    await identicalGate.reachedPromise;
    await vi.runAllTimersAsync();
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce();

    identicalGate.resolve();
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledTimes(2);
    expect(h.channel.updates.map((update) => update.sequence)).toEqual([1, 2]);
    expect(operationSequence(h.channel.rawClient.cardkit.v1.card.settings.mock.calls[0]?.[0])).toBe(
      3,
    );
  });

  it('keeps a terminal update behind an in-flight running projection', async () => {
    const terminalGate = controllableEventGate(1);
    const heldUpdate = Promise.withResolvers<unknown>();
    let updateAttempt = 0;
    const h = await createHarness({
      events: [
        { type: 'reasoning', content: 'RUNNINGPROJECTION' },
        { type: 'done', terminationReason: 'normal' },
      ] satisfies readonly AgentEvent[],
      eventGates: [terminalGate],
      update: async () => {
        updateAttempt++;
        return updateAttempt === 1 ? heldUpdate.promise : { code: 0 };
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_in_flight', 'run'));
    await vi.waitFor(() => expect(h.channel.operations).toContain('omp:consume'));
    await terminalGate.reachedPromise;
    await vi.runAllTimersAsync();
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce();
    expect(operationSequence(h.channel.rawClient.cardkit.v1.card.update.mock.calls[0]?.[0])).toBe(
      1,
    );

    terminalGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce();
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();

    heldUpdate.resolve({ code: 0 });
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );
    expect(h.channel.updates.map((update) => update.sequence)).toEqual([1, 2]);
    expect(operationSequence(h.channel.rawClient.cardkit.v1.card.settings.mock.calls[0]?.[0])).toBe(
      3,
    );
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('never lets terminal close overtake an unresolved final update', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'UNCONFIRMED_FINAL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      update: async () => {
        throw new Error('upstream unavailable');
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_unresolved', 'run'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    const updates = h.channel.rawClient.cardkit.v1.card.update.mock.calls.map(([input]) =>
      JSON.stringify(input),
    );
    expect(updates).toHaveLength(3);
    expect(updates).toEqual([updates[0], updates[0], updates[0]]);
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('keeps Commands and Run Rejections on ordinary replies', async () => {
    const command = await createHarness();
    await startTestBridge(command);
    await command.channel.handlers.message?.(message('om_command', '/status'));
    await waitFor(() => command.channel.sent.length === 1);

    expect(command.agent.runOptions).toHaveLength(0);
    expect(command.channel.createdCards).toHaveLength(0);
    expect(command.channel.rawClient.im.v1.message.reply).not.toHaveBeenCalled();

    const rejection = await createHarness({ configuredWorkspace: false });
    await startTestBridge(rejection);
    await rejection.channel.handlers.message?.(message('om_rejection', 'run'));
    await waitFor(() => rejection.channel.sent.length === 1);

    expect(rejection.agent.runOptions).toHaveLength(0);
    expect(rejection.channel.createdCards).toHaveLength(0);
    expect(rejection.channel.rawClient.im.v1.message.reply).not.toHaveBeenCalled();
    expect(rejection.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_rejection' });
  });
  it('renders model, configuration, total duration, usage, and TPS in one footer', async () => {
    const h = await createHarness({
      wallNow: clock(1_000_500),
      monoNow: clock(100, 2_600, 3_850, 125_100),
      events: [
        { type: 'prompt_sent' },
        {
          type: 'system',
          modelId: 'gpt-test',
          effort: 'high',
          contextPercent: 7.25,
        },
        { type: 'text_started' },
        { type: 'final_text', content: 'measured answer' },
        {
          type: 'usage',
          inputTokens: 900,
          cacheReadTokens: 50,
          cacheWriteTokens: 25,
          outputTokens: 999,
        },
        {
          type: 'usage',
          inputTokens: 100,
          cacheReadTokens: 10,
          cacheWriteTokens: 15,
          outputTokens: 1,
        },
        { type: 'usage' },
        { type: 'tool_use', id: 'tool-a', name: 'read', input: {} },
        { type: 'tool_use', id: 'tool-a', name: 'read', input: {} },
        { type: 'tool_result', id: 'tool-a', output: '', isError: false },
        { type: 'tool_use', id: 'tool-b', name: 'bash', input: {} },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_metrics', 'run', 1_000_000));
    await waitFor(() =>
      h.channel.operations.some((operation) => operation.startsWith('card:close:')),
    );

    const metrics = cardElements(h.channel.updates.at(-1)?.card).filter(
      (element) => 'element_id' in element && element.element_id === 'metrics',
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        content:
          "<font color='grey'>gpt-test · effort high · ctx 7.3% · 总耗时 2m5s · 输入 1.1k · 输出 1.0k · TPS 8.2</font>",
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toMatch(/provider|工具|飞书到达|前置|首字|OMP/);
  });

  it('starts total elapsed time from the last message admitted to a Message Batch', async () => {
    const h = await createHarness({
      wallNow: clock(1_000, 2_000),
      monoNow: clock(0, 100, 1_100, 2_100),
      events: [{ type: 'prompt_sent' }, { type: 'done', terminationReason: 'normal' }],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_batch_first', 'first'));
    await h.channel.handlers.message?.(message('om_batch_last', 'last'));
    await waitFor(() =>
      h.channel.operations.some((operation) => operation.startsWith('card:close:')),
    );

    const outbound = JSON.stringify(h.channel.updates.at(-1)?.card);
    expect(outbound).toContain('总耗时 2.0s');
    expect(h.channel.rawClient.im.v1.message.reply.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: 'om_batch_last' },
    });
  });

  it.each([
    {
      name: 'done',
      terminal: { type: 'done', terminationReason: 'normal' },
    },
    {
      name: 'interrupted',
      terminal: { type: 'done', terminationReason: 'interrupted' },
    },
    {
      name: 'idle timeout',
      terminal: { type: 'done', terminationReason: 'timeout' },
    },
    {
      name: 'error',
      terminal: { type: 'error', message: 'SECRET', terminationReason: 'failed' },
    },
  ] satisfies readonly {
    name: string;
    terminal: AgentEvent;
  }[])(
    'freezes available metrics on $name without inventing missing values',
    async ({ terminal }) => {
      const h = await createHarness({
        wallNow: clock(1_000),
        monoNow: clock(10, 1_010, 61_010),
        events: [
          { type: 'prompt_sent' },
          { type: 'usage', inputTokens: 12 },
          terminal,
          { type: 'usage', inputTokens: 999, outputTokens: 999 },
        ],
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_frozen_${terminal.type}`, 'run'));
      await waitFor(() =>
        h.channel.operations.some((operation) => operation.startsWith('card:close:')),
      );

      const outbound = JSON.stringify(h.channel.updates.at(-1)?.card);
      expect(outbound).toContain('总耗时 1m1s');
      expect(outbound).toContain('输入 12');
      expect(outbound).not.toContain('输出 ');
      expect(outbound).not.toContain('TPS ');
      expect(outbound).not.toMatch(/飞书到达|前置|首字|OMP/);
      expect(outbound).not.toContain('999');
    },
  );

  it('keeps the frozen metric projection byte-identical across exact delivery retries', async () => {
    const h = await createHarness({
      wallNow: clock(1_000),
      monoNow: clock(0, 1_000, 2_000, 3_000),
      events: [
        { type: 'prompt_sent' },
        { type: 'text_started' },
        { type: 'usage', inputTokens: 5, cacheReadTokens: 2, outputTokens: 3 },
        { type: 'tool_use', id: 'tool-once', name: 'read', input: {} },
        { type: 'tool_use', id: 'tool-once', name: 'read', input: {} },
        { type: 'done', terminationReason: 'normal' },
      ],
      update: async () => {
        throw new Error('upstream unavailable');
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_metric_retry', 'run'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    const updates = h.channel.rawClient.cardkit.v1.card.update.mock.calls.map(([input]) =>
      JSON.stringify(input),
    );
    expect(updates).toHaveLength(3);
    expect(updates).toEqual([updates[0], updates[0], updates[0]]);
    expect(updates[0]).toContain('输入 7');
    expect(updates[0]).toContain('输出 3');
  });
});

async function createHarness(
  options: {
    events?: FakeAgentEvents;
    configuredWorkspace?: boolean;
    eventGates?: readonly EventGate[];
    reply?: (input: unknown) => Promise<unknown>;
    update?: (input: unknown) => Promise<unknown>;
    close?: (input: unknown) => Promise<unknown>;
    wallNow?: () => number;
    monoNow?: () => number;
  } = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  controls: Controls;
  wallNow?: () => number;
  monoNow?: () => number;
}> {
  const tmp = await createTmpProfile('p2p-reply-controller-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    accounts: {
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    },
    access: { allowedUsers: ['ou_user'] },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      ...(options.configuredWorkspace === false ? {} : { default: workspace }),
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createFakeLarkChannel(options);
  const agent = new FakeAgentAdapter({
    events:
      options.events ??
      ([
        { type: 'text', delta: 'ok' },
        { type: 'done', terminationReason: 'normal' },
      ] satisfies FakeAgentEvents),
    onEventStreamStart: () => channel.operations.push('omp:consume'),
  });
  if (options.eventGates) {
    const start = agent.start.bind(agent);
    vi.spyOn(agent, 'start').mockImplementation(async (runOptions) => {
      const run = await start(runOptions);
      const source = run.events;
      const events = (async function* () {
        let count = 0;
        for await (const event of source) {
          yield event;
          count++;
          const gate = options.eventGates?.find((candidate) => candidate.after === count);
          if (gate) {
            gate.reached?.();
            await gate.promise;
          }
        }
      })();
      return {
        runId: run.runId,
        events,
        stop: () => run.stop(),
        waitForExit: (timeoutMs) => run.waitForExit(timeoutMs),
      };
    });
  }
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
    ...(options.wallNow ? { wallNow: options.wallNow } : {}),
    ...(options.monoNow ? { monoNow: options.monoNow } : {}),
  };
}
async function startTestBridge(harness: {
  profileConfig: ProfileConfig;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
  wallNow?: () => number;
  monoNow?: () => number;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: harness.profileConfig,
    agent: harness.agent,
    sessions: harness.sessions,
    workspaces: harness.workspaces,
    controls: harness.controls,
    ...(harness.wallNow ? { wallNow: harness.wallNow } : {}),
    ...(harness.monoNow ? { monoNow: harness.monoNow } : {}),
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(
  options: {
    reply?: (input: unknown) => Promise<unknown>;
    update?: (input: unknown) => Promise<unknown>;
    close?: (input: unknown) => Promise<unknown>;
  } = {},
): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const operations: string[] = [];
  const createdCards: object[] = [];
  const updates: FakeLarkChannel['updates'] = [];
  const sent: FakeLarkChannel['sent'] = [];
  const streams: unknown[] = [];
  const replyMock = vi.fn(async (input: unknown) => {
    operations.push('im:reply');
    return options.reply ? options.reply(input) : { code: 0, data: { message_id: 'om_reply_1' } };
  });
  const update = vi.fn(async (input: unknown) => {
    const sequence = operationSequence(input);
    const cardId = operationCardId(input);
    const cardData = updateCardData(input);
    if (sequence === undefined || !cardId || !cardData) {
      throw new Error('invalid captured CardKit update');
    }
    operations.push(`card:update:${sequence}`);
    updates.push({ cardId, card: JSON.parse(cardData), sequence });
    return options.update ? options.update(input) : { code: 0 };
  });
  const settings = vi.fn(async (input: unknown) => {
    const sequence = operationSequence(input);
    operations.push(`card:close:${sequence}`);
    return options.close ? options.close(input) : { code: 0 };
  });

  return {
    handlers,
    operations,
    createdCards,
    updates,
    sent,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            reply: replyMock,
          },
          messageReaction: {
            create: vi.fn(async (input: unknown) => {
              operations.push(`reaction:add:${reactionEmojiType([input])}`);
              return { data: { reaction_id: 'reaction_1' } };
            }),
            delete: vi.fn(async (input: unknown) => {
              operations.push(`reaction:delete:${reactionRequestId(input)}`);
              return {};
            }),
          },
        },
      },
      cardkit: { v1: { card: { update, settings } } },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async createCard(card) {
      operations.push('card:create');
      createdCards.push(card);
      return { cardId: 'card_1' };
    },
    async updateCardById(cardId, card, sequence) {
      operations.push(`card:update:${sequence}`);
      updates.push({ cardId, card, sequence });
    },
    async send(chatId, content, options) {
      operations.push('ordinary:send');
      sent.push({ chatId, content, options });
      return { messageId: `om_ordinary_${sent.length}` };
    },
    async stream(_chatId, input) {
      streams.push(input);
    },
  };
}

function createControls(profileConfig: ProfileConfig): Controls {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(
  messageId: string,
  content: string,
  createTime: number | null = 1760000001000,
): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_p2p',
    chatType: 'p2p',
    senderId: 'ou_user',
    content,
    contentType: 'text',
    resources: [],
    mentionedBot: false,
    ...(createTime === null ? {} : { createTime }),
  } as unknown as NormalizedMessage;
}

function replyCardId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  const data = input.data;
  if (!data || typeof data !== 'object' || !('content' in data)) return undefined;
  if (typeof data.content !== 'string') return undefined;
  let content: unknown;
  try {
    content = JSON.parse(data.content);
  } catch {
    return undefined;
  }
  if (!content || typeof content !== 'object' || !('data' in content)) return undefined;
  const cardData = content.data;
  if (!cardData || typeof cardData !== 'object' || !('card_id' in cardData)) return undefined;
  return typeof cardData.card_id === 'string' ? cardData.card_id : undefined;
}

function operationSequence(input: unknown): number | undefined {
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  const data = input.data;
  if (!data || typeof data !== 'object' || !('sequence' in data)) return undefined;
  return typeof data.sequence === 'number' ? data.sequence : undefined;
}

function operationCardId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) return undefined;
  const path = input.path;
  if (!path || typeof path !== 'object' || !('card_id' in path)) return undefined;
  return typeof path.card_id === 'string' ? path.card_id : undefined;
}

function updateCardData(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  const data = input.data;
  if (!data || typeof data !== 'object' || !('card' in data)) return undefined;
  const card = data.card;
  if (!card || typeof card !== 'object' || !('data' in card)) return undefined;
  return typeof card.data === 'string' ? card.data : undefined;
}

function closeSettings(input: unknown): string {
  if (!input || typeof input !== 'object' || !('data' in input)) return '';
  const data = input.data;
  if (!data || typeof data !== 'object' || !('settings' in data)) return '';
  return typeof data.settings === 'string' ? data.settings : '';
}

function cardElements(card: object | undefined): object[] {
  if (!card || !('body' in card)) return [];
  const body = card.body;
  if (!body || typeof body !== 'object' || !('elements' in body) || !Array.isArray(body.elements)) {
    return [];
  }
  return body.elements.filter(
    (element): element is object => element !== null && typeof element === 'object',
  );
}

function totalCardElements(card: object | undefined): number {
  if (!card) return 0;
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

function reactionEmojiType(call: unknown[]): string | undefined {
  const input = call[0];
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  const data = input.data;
  if (!data || typeof data !== 'object' || !('reaction_type' in data)) return undefined;
  const reactionType = data.reaction_type;
  if (!reactionType || typeof reactionType !== 'object' || !('emoji_type' in reactionType)) {
    return undefined;
  }
  return typeof reactionType.emoji_type === 'string' ? reactionType.emoji_type : undefined;
}

function reactionRequestId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) return undefined;
  const path = input.path;
  if (!path || typeof path !== 'object' || !('reaction_id' in path)) return undefined;
  return typeof path.reaction_id === 'string' ? path.reaction_id : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function clock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index++];
    if (value === undefined) throw new Error(`controlled clock exhausted at call ${index}`);
    return value;
  };
}
