import type * as LarkChannelModule from '@larksuite/channel';
import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
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
    cardkit: { v1: { card: { settings: Mock<(input: unknown) => Promise<unknown>> } } };
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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

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
    await waitFor(() => h.channel.operations.some((operation) => operation.startsWith('card:close:')));

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
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);

    const finalUpdate = h.channel.updates.at(-1);
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
  });

  it('fails closed when the initial IM Reply result is ambiguous', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'MUST_NOT_BE_CONSUMED' },
        { type: 'done', terminationReason: 'normal' },
      ],
      reply: async () => {
        throw new Error('request timed out');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_ambiguous', 'run'));
    await waitFor(() => h.agent.runs[0]?.stopped === true);

    expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(h.channel.createdCards).toHaveLength(1);
    expect(h.channel.updates).toHaveLength(0);
    expect(h.channel.rawClient.cardkit.v1.card.settings).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.operations).not.toContain('omp:consume');
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
});

async function createHarness(
  options: {
    events?: FakeAgentEvents;
    configuredWorkspace?: boolean;
    reply?: (input: unknown) => Promise<unknown>;
  } = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  controls: Controls;
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
  const channel = createFakeLarkChannel(options.reply);
  const agent = new FakeAgentAdapter({
    events:
      options.events ??
      ([
        { type: 'text', delta: 'ok' },
        { type: 'done', terminationReason: 'normal' },
      ] satisfies FakeAgentEvents),
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

function createFakeLarkChannel(
  reply: (input: unknown) => Promise<unknown> = async () => ({
    data: { message_id: 'om_reply_1' },
  }),
): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const operations: string[] = [];
  const createdCards: object[] = [];
  const updates: FakeLarkChannel['updates'] = [];
  const sent: FakeLarkChannel['sent'] = [];
  const streams: unknown[] = [];
  const replyMock = vi.fn(async (input: unknown) => {
    operations.push('im:reply');
    return reply(input);
  });
  const settings = vi.fn(async (input: unknown) => {
    const sequence = operationSequence(input);
    operations.push(`card:close:${sequence}`);
    return { code: 0 };
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
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
      cardkit: { v1: { card: { settings } } },
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

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function operationSequence(input: unknown): number | undefined {
  if (!input || typeof input !== 'object' || !('data' in input)) return undefined;
  const data = input.data;
  if (!data || typeof data !== 'object' || !('sequence' in data)) return undefined;
  return typeof data.sequence === 'number' ? data.sequence : undefined;
}

function closeSettings(input: unknown): string {
  if (!input || typeof input !== 'object' || !('data' in input)) return '';
  const data = input.data;
  if (!data || typeof data !== 'object' || !('settings' in data)) return '';
  return typeof data.settings === 'string' ? data.settings : '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
