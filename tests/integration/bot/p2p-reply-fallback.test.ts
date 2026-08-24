import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type * as LarkChannelModule from '@larksuite/channel';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
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
  patches: Array<{ messageId: string; card: object }>;
  successfulReplyIds: string[];
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
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
          patch: Mock<(input: unknown) => Promise<unknown>>;
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
  botIdentity: { openId: string; name: string };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(card: object): Promise<{ cardId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  updateCardById(cardId: string, card: object, sequence: number): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

type FixtureOptions = {
  events?: FakeAgentEvents;
  createCard?: (card: object) => Promise<{ cardId: string }>;
  reply?: (input: unknown, attempt: number) => Promise<unknown>;
  update?: (input: unknown, attempt: number) => Promise<unknown>;
  close?: (input: unknown, attempt: number) => Promise<unknown>;
  patch?: (messageId: string, card: object, attempt: number) => Promise<unknown>;
  trustedPeerBots?: Array<{ alias: string; openId: string }>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('P2P OMP Reply safe fallback', () => {
  it('falls from a confirmed managed rejection to one inline card and patches that message', async () => {
    const h = await createHarness({
      events: terminalEvents('INLINE_FINAL_SENTINEL'),
      reply: async (_input, attempt) =>
        attempt === 1 ? { code: 230001, msg: 'not submitted' } : successReply('om_inline'),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_trigger'));
    await waitFor(() => h.channel.patches.length === 1);

    const replies = replyInputs(h.channel);
    expect(replies).toHaveLength(2);
    expect(replyType(replies[0])).toBe('interactive');
    expect(replyCardId(replies[0])).toBe('card_1');
    expect(replyType(replies[1])).toBe('interactive');
    expect(replyCardId(replies[1])).toBeUndefined();
    expect(h.channel.successfulReplyIds).toEqual(['om_inline']);
    expect(h.channel.patches[0]?.messageId).toBe('om_inline');
    expect(JSON.stringify(h.channel.patches[0]?.card)).toContain('INLINE_FINAL_SENTINEL');
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
  });

  it('abandons an orphaned managed entity before IM submission and opens one inline card', async () => {
    const h = await createHarness({
      events: terminalEvents('ORPHAN_FINAL_SENTINEL'),
      createCard: async () => {
        throw new Error('CardKit create receipt lost');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_orphan'));
    await waitFor(() => h.channel.patches.length === 1);

    const replies = replyInputs(h.channel);
    expect(replies).toHaveLength(1);
    expect(replyType(replies[0])).toBe('interactive');
    expect(replyCardId(replies[0])).toBeUndefined();
    expect(h.channel.successfulReplyIds).toEqual(['om_reply_1']);
    expect(h.channel.patches[0]?.messageId).toBe('om_reply_1');
  });

  it('uses one terminal Markdown Reply only after both card submissions are confirmed rejected', async () => {
    const h = await createHarness({
      events: terminalEvents('MARKDOWN_FINAL_SENTINEL'),
      reply: async (_input, attempt) =>
        attempt < 3 ? { code: 230001, msg: 'not submitted' } : successReply('om_markdown'),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_markdown_trigger'));
    await waitFor(() => h.channel.successfulReplyIds.length === 1);

    const replies = replyInputs(h.channel);
    expect(replies.map(replyType)).toEqual(['interactive', 'interactive', 'post']);
    expect(replyCardId(replies[0])).toBe('card_1');
    expect(replyCardId(replies[1])).toBeUndefined();
    expect(replyContent(replies[2])).toContain('MARKDOWN_FINAL_SENTINEL');
    expect(h.channel.successfulReplyIds).toEqual(['om_markdown']);
    expect(h.channel.patches).toHaveLength(0);
    expect(h.channel.operations).toContain('omp:consume');
  });

  it('keeps sender and one peer semantics across managed, inline, and Markdown transports', async () => {
    for (const transport of ['managed', 'inline', 'markdown'] as const) {
      const h = await createHarness({
        events: terminalEvents(
          `\`\`\`text\n${'x'.repeat(40_000)}\n\`\`\`\nbefore @Hermes after ${transport}`,
        ),
        trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
        ...(transport === 'managed'
          ? {}
          : {
              createCard: async () => {
                throw new Error('managed unavailable');
              },
            }),
        ...(transport === 'markdown'
          ? {
              reply: async (_input: unknown, attempt: number) =>
                attempt === 1
                  ? { code: 230001, msg: 'inline rejected' }
                  : successReply(`om_${transport}`),
            }
          : {}),
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(verifiedMessage(`om_${transport}`));
      await waitFor(() =>
        transport === 'managed'
          ? h.channel.rawClient.cardkit.v1.card.update.mock.calls.length > 0
          : transport === 'inline'
            ? h.channel.patches.length > 0
            : h.channel.successfulReplyIds.length > 0,
      );

      const outbound =
        transport === 'managed'
          ? updateCardData(h.channel.rawClient.cardkit.v1.card.update.mock.calls.at(-1)?.[0]) ?? ''
          : transport === 'inline'
            ? JSON.stringify(h.channel.patches.at(-1)?.card)
            : replyContent(replyInputs(h.channel).at(-1));
      expect(outbound).toContain('内容过长，已截断');
      expect(outbound).toContain('ou_user');
      expect(outbound).toContain('ou_peer');
      expect(outbound.match(/ou_peer/g)).toHaveLength(1);
      expect(outbound).not.toContain('```');
      expect(replyInputs(h.channel).every((input) => requestMessageId(input) === `om_${transport}`)).toBe(
        true,
      );
      expect(h.channel.successfulReplyIds).toHaveLength(1);
    }
  });

  it('exact-retries an unknown managed submission and never changes transport', async () => {
    const h = await createHarness({
      reply: async () => {
        throw new Error('socket disconnected');
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_unknown'));
    await vi.waitFor(() => expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce());
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    const replies = replyInputs(h.channel).map((input) => JSON.stringify(input));
    expect(replies).toHaveLength(3);
    expect(replies).toEqual([replies[0], replies[0], replies[0]]);
    expect(replyInputs(h.channel).every((input) => replyCardId(input) === 'card_1')).toBe(true);
    expect(h.channel.successfulReplyIds).toHaveLength(0);
    expect(h.channel.operations).not.toContain('omp:consume');
  });

  it('does not send another Reply after retry proves a managed card binding without a message id', async () => {
    const h = await createHarness({
      events: terminalEvents('BOUND_FINAL_SENTINEL'),
      reply: async () => ({ code: 200780 }),
      update: async () => ({ code: 230001, msg: 'terminal update rejected' }),
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_bound'));
    await vi.waitFor(() => expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce());
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    const replies = replyInputs(h.channel).map((input) => JSON.stringify(input));
    expect(replies).toHaveLength(2);
    expect(replies[1]).toBe(replies[0]);
    expect(h.channel.patches).toHaveLength(0);
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
  });

  it('exact-retries an uncertain terminal update, then patches the known message after clear rejection', async () => {
    const h = await createHarness({
      events: terminalEvents('UPDATE_RECOVERY_SENTINEL'),
      update: async (_input, attempt) =>
        attempt === 1 ? { status: 503 } : { code: 230001, msg: 'rejected' },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_update_recovery'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.update).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.channel.patches.length).toBe(1));

    const updates = h.channel.rawClient.cardkit.v1.card.update.mock.calls.map(([input]) =>
      JSON.stringify(input),
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]).toBe(updates[0]);
    expect(h.channel.patches[0]?.messageId).toBe('om_reply_1');
    expect(JSON.stringify(h.channel.patches[0]?.card)).toContain('UPDATE_RECOVERY_SENTINEL');
    expect(h.channel.successfulReplyIds).toEqual(['om_reply_1']);
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
  });

  it('exact-retries an uncertain close, then patches the known message after clear rejection', async () => {
    const h = await createHarness({
      events: terminalEvents('CLOSE_RECOVERY_SENTINEL'),
      close: async (_input, attempt) =>
        attempt === 1 ? { status: 503 } : { code: 230001, msg: 'rejected' },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_close_recovery'));
    await vi.waitFor(() =>
      expect(h.channel.rawClient.cardkit.v1.card.settings).toHaveBeenCalledOnce(),
    );
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.channel.patches.length).toBe(1));

    const closes = h.channel.rawClient.cardkit.v1.card.settings.mock.calls.map(([input]) =>
      JSON.stringify(input),
    );
    expect(closes).toHaveLength(2);
    expect(closes[1]).toBe(closes[0]);
    expect(h.channel.patches[0]?.messageId).toBe('om_reply_1');
    expect(JSON.stringify(h.channel.patches[0]?.card)).toContain('CLOSE_RECOVERY_SENTINEL');
    expect(h.channel.successfulReplyIds).toEqual(['om_reply_1']);
  });

  it('records Delivery Failure after a clearly rejected same-message static patch', async () => {
    const failLog = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: terminalEvents('PATCH_FAILURE_SENTINEL'),
      update: async () => ({ code: 230001, msg: 'rejected' }),
      patch: async () => ({ code: 230002, msg: 'static patch rejected' }),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_patch_failure'));
    await waitFor(() => h.agent.runs[0]?.stopped === true);
    expect(failLog).toHaveBeenCalledWith(
      'reply',
      expect.objectContaining({ name: 'OmpReplyDeliveryFailure' }),
      expect.objectContaining({ step: 'im' }),
    );

    expect(h.channel.patches).toHaveLength(1);
    expect(h.channel.patches[0]?.messageId).toBe('om_reply_1');
    expect(h.channel.successfulReplyIds).toEqual(['om_reply_1']);
    expect(replyInputs(h.channel)).toHaveLength(1);
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
  });

  it('exact-retries an uncertain static patch and never sends a replacement bubble', async () => {
    const h = await createHarness({
      events: terminalEvents('PATCH_UNKNOWN_SENTINEL'),
      update: async () => ({ code: 230001, msg: 'rejected' }),
      patch: async () => {
        throw new Error('patch connection lost');
      },
    });
    await startTestBridge(h);
    vi.useFakeTimers();

    void h.channel.handlers.message?.(message('om_patch_unknown'));
    await vi.waitFor(() => expect(h.channel.patches).toHaveLength(1));
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(h.agent.runs[0]?.stopped).toBe(true));

    expect(h.channel.patches).toHaveLength(3);
    expect(h.channel.patches.map((patch) => patch.messageId)).toEqual([
      'om_reply_1',
      'om_reply_1',
      'om_reply_1',
    ]);
    expect(h.channel.patches.map((patch) => JSON.stringify(patch.card))).toEqual([
      JSON.stringify(h.channel.patches[0]?.card),
      JSON.stringify(h.channel.patches[0]?.card),
      JSON.stringify(h.channel.patches[0]?.card),
    ]);
    expect(replyInputs(h.channel)).toHaveLength(1);
    expect(h.channel.successfulReplyIds).toEqual(['om_reply_1']);
  });
});

async function createHarness(options: FixtureOptions = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  controls: Controls;
}> {
  const tmp = await createTmpProfile('p2p-reply-fallback-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    access: { allowedUsers: ['ou_user'] },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
    collaboration: {
      ...baseProfileConfig.collaboration,
      trustedPeerBots: options.trustedPeerBots ?? [],
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createFakeLarkChannel(options);
  const agent = new FakeAgentAdapter({
    events: options.events ?? terminalEvents('ok'),
    onEventStreamStart: () => channel.operations.push('omp:consume'),
  });
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

async function startTestBridge(harness: {
  profileConfig: ProfileConfig;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: harness.profileConfig,
    agent: harness.agent,
    sessions: harness.sessions,
    workspaces: harness.workspaces,
    controls: harness.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: FixtureOptions): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const operations: string[] = [];
  const createdCards: object[] = [];
  const patches: FakeLarkChannel['patches'] = [];
  const successfulReplyIds: string[] = [];
  const sent: FakeLarkChannel['sent'] = [];
  let replyAttempt = 0;
  let updateAttempt = 0;
  let closeAttempt = 0;
  let patchAttempt = 0;

  const reply = vi.fn(async (input: unknown) => {
    operations.push(`im:reply:${replyType(input) ?? 'unknown'}`);
    replyAttempt++;
    const result = options.reply
      ? await options.reply(input, replyAttempt)
      : successReply('om_reply_1');
    const messageId = responseMessageId(result);
    if (messageId) successfulReplyIds.push(messageId);
    return result;
  });
  const update = vi.fn(async (input: unknown) => {
    operations.push(`card:update:${operationSequence(input) ?? 'unknown'}`);
    updateAttempt++;
    return options.update ? options.update(input, updateAttempt) : { code: 0 };
  });
  const settings = vi.fn(async (input: unknown) => {
    operations.push(`card:close:${operationSequence(input) ?? 'unknown'}`);
    closeAttempt++;
    return options.close ? options.close(input, closeAttempt) : { code: 0 };
  });
  const patch = vi.fn(async (input: unknown) => {
    const messageId = requestMessageId(input);
    const content = replyContent(input);
    if (!messageId || !content) throw new Error('invalid captured message patch');
    const card: unknown = JSON.parse(content);
    if (!card || typeof card !== 'object') throw new Error('invalid captured static card');
    operations.push('message:patch');
    patches.push({ messageId, card });
    patchAttempt++;
    return options.patch ? options.patch(messageId, card, patchAttempt) : { code: 0 };
  });

  return {
    handlers,
    operations,
    createdCards,
    patches,
    successfulReplyIds,
    sent,
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
            reply,
            patch,
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
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
      return options.createCard ? options.createCard(card) : { cardId: 'card_1' };
    },
    async updateCard(messageId, card) {
      operations.push('message:patch');
      patches.push({ messageId, card });
      patchAttempt++;
      await options.patch?.(messageId, card, patchAttempt);
    },
    async updateCardById() {},
    async send(chatId, content, sendOptions) {
      sent.push({ chatId, content, options: sendOptions });
      return { messageId: `om_ordinary_${sent.length}` };
    },
    async stream() {},
  };
}

function createControls(profileConfig: ProfileConfig): Controls {
  return {
    profile: 'test',
    ownerRefreshState: 'unknown',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function terminalEvents(content: string): FakeAgentEvents {
  return [
    { type: 'text', delta: content },
    { type: 'done', terminationReason: 'normal' },
  ];
}

function message(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: 'run',
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function verifiedMessage(messageId: string): NormalizedMessage {
  return {
    ...message(messageId),
    senderId: 'ou_user',
    raw: {
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
    },
  };
}

function successReply(messageId: string): object {
  return { code: 0, data: { message_id: messageId } };
}

function replyInputs(channel: FakeLarkChannel): unknown[] {
  return channel.rawClient.im.v1.message.reply.mock.calls.map(([input]) => input);
}

function replyType(input: unknown): string | undefined {
  const data = requestData(input);
  return data && 'msg_type' in data && typeof data.msg_type === 'string'
    ? data.msg_type
    : undefined;
}

function replyContent(input: unknown): string {
  const data = requestData(input);
  return data && 'content' in data && typeof data.content === 'string' ? data.content : '';
}

function replyCardId(input: unknown): string | undefined {
  let content: unknown;
  try {
    content = JSON.parse(replyContent(input));
  } catch {
    return undefined;
  }
  if (!content || typeof content !== 'object' || !('data' in content)) return undefined;
  const data = content.data;
  if (!data || typeof data !== 'object' || !('card_id' in data)) return undefined;
  return typeof data.card_id === 'string' ? data.card_id : undefined;
}

function requestData(input: unknown): object | undefined {
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  return input.data && typeof input.data === 'object' ? input.data : undefined;
}

function requestMessageId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) return undefined;
  const path = input.path;
  if (!path || typeof path !== 'object' || !('message_id' in path)) return undefined;
  return typeof path.message_id === 'string' ? path.message_id : undefined;
}

function updateCardData(input: unknown): string | undefined {
  const data = requestData(input);
  if (!data || !('card' in data)) return undefined;
  const card = data.card;
  if (!card || typeof card !== 'object' || !('data' in card)) return undefined;
  return typeof card.data === 'string' ? card.data : undefined;
}

function responseMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('data' in result)) return undefined;
  const data = result.data;
  if (!data || typeof data !== 'object' || !('message_id' in data)) return undefined;
  return typeof data.message_id === 'string' ? data.message_id : undefined;
}

function operationSequence(input: unknown): number | undefined {
  const data = requestData(input);
  return data && 'sequence' in data && typeof data.sequence === 'number'
    ? data.sequence
    : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
