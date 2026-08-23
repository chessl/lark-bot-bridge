import type * as LarkChannelModule from '@larksuite/channel';
import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
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
  createdCards: object[];
  sent: unknown[];
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
          list: Mock<(...args: unknown[]) => Promise<unknown>>;
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
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(card: object): Promise<{ cardId: string }>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

interface PlacementCase {
  name: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  chatMode: 'group' | 'topic';
  messages: Array<{
    messageId: string;
    threadId?: string;
    rootId?: string;
    parentId?: string;
  }>;
  expectedMessageId: string;
  replyInThread: boolean;
}

const placementCases: PlacementCase[] = [
  {
    name: 'private Chat',
    chatId: 'oc_private',
    chatType: 'p2p',
    chatMode: 'group',
    messages: [{ messageId: 'om_private_first' }, { messageId: 'om_private_final' }],
    expectedMessageId: 'om_private_final',
    replyInThread: false,
  },
  {
    name: 'regular group Chat',
    chatId: 'oc_group',
    chatType: 'group',
    chatMode: 'group',
    messages: [{ messageId: 'om_group_first' }, { messageId: 'om_group_final' }],
    expectedMessageId: 'om_group_final',
    replyInThread: false,
  },
  {
    name: 'Topic root',
    chatId: 'oc_topic_root',
    chatType: 'group',
    chatMode: 'topic',
    messages: [
      {
        messageId: 'om_topic_root',
        threadId: 'omt_topic_root',
        rootId: 'om_topic_root',
      },
    ],
    expectedMessageId: 'om_topic_root',
    replyInThread: true,
  },
  {
    name: 'Topic child',
    chatId: 'oc_topic_child',
    chatType: 'group',
    chatMode: 'topic',
    messages: [
      {
        messageId: 'om_topic_child_first',
        threadId: 'omt_topic_child',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
      },
      {
        messageId: 'om_topic_child_final',
        threadId: 'omt_topic_child',
        rootId: 'om_topic_root',
        parentId: 'om_topic_child_first',
      },
    ],
    expectedMessageId: 'om_topic_child_final',
    replyInThread: true,
  },
  {
    name: 'explicit reply-in-thread when Chat metadata says group',
    chatId: 'oc_explicit_thread',
    chatType: 'group',
    chatMode: 'group',
    messages: [
      {
        messageId: 'om_thread_first',
        threadId: 'omt_explicit',
        rootId: 'om_thread_root',
        parentId: 'om_thread_root',
      },
      {
        messageId: 'om_thread_final',
        threadId: 'omt_explicit',
        rootId: 'om_thread_root',
        parentId: 'om_thread_first',
      },
    ],
    expectedMessageId: 'om_thread_final',
    replyInThread: true,
  },
];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('OMP Reply placement', () => {
  it.each(placementCases)(
    'sends one native Reply to the final Message Batch item in $name',
    async (placement) => {
      const h = await createHarness(placement);
      await startTestBridge(h);

      for (const input of placement.messages) {
        await h.channel.handlers.message?.(message(placement, input));
      }
      await waitFor(() => h.channel.rawClient.cardkit.v1.card.settings.mock.calls.length === 1);

      expect(h.agent.runOptions).toHaveLength(1);
      expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledOnce();
      expect(h.channel.rawClient.im.v1.message.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: placement.expectedMessageId },
          data: expect.objectContaining({
            msg_type: 'interactive',
            reply_in_thread: placement.replyInThread,
          }),
        }),
      );
      expect(h.channel.createdCards).toHaveLength(1);
      expect(h.channel.sent).toHaveLength(0);
      expect(h.channel.streams).toHaveLength(0);
    },
  );
});

async function createHarness(placement: PlacementCase): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  controls: Controls;
}> {
  const tmp = await createTmpProfile('reply-placement-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    accounts: {
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    },
    access: {
      allowedChats: [placement.chatId],
      allowedUsers: ['ou_user'],
    },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createFakeLarkChannel(placement.chatMode);
  const agent = new FakeAgentAdapter({
    events: [
      { type: 'text', delta: 'ok' },
      { type: 'done', terminationReason: 'normal' },
    ],
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

function createFakeLarkChannel(chatMode: 'group' | 'topic'): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const createdCards: object[] = [];
  const sent: unknown[] = [];
  const streams: unknown[] = [];

  return {
    handlers,
    createdCards,
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
            list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
            reply: vi.fn(async () => ({ data: { message_id: 'om_reply_1' } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
      cardkit: {
        v1: {
          card: {
            update: vi.fn(async () => ({ code: 0 })),
            settings: vi.fn(async () => ({ code: 0 })),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async createCard(card) {
      createdCards.push(card);
      return { cardId: 'card_1' };
    },
    async send(_chatId, content) {
      sent.push(content);
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
  placement: PlacementCase,
  input: PlacementCase['messages'][number],
): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: placement.chatId,
    chatType: placement.chatType,
    senderId: 'ou_user',
    senderName: 'User',
    content: '@Bridge run',
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: placement.chatType === 'group',
    createTime: 1760000001000,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.rootId ? { rootId: input.rootId } : {}),
    ...(input.parentId
      ? { parentId: input.parentId, replyToMessageId: input.parentId }
      : {}),
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await delay(10);
  }
}
