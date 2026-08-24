import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
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
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  vi.useRealTimers();
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bot identity injection into the agent adapter', () => {
  it('passes channel.botIdentity to the adapter after connect', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    expect(h.agent.botIdentity).toEqual({ openId: 'ou_bot', name: 'Bridge' });
  });
});

describe('sender identity in bridge_context', () => {
  it('projects a trusted direct peer through aliases without canonical peer IDs', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.trustedPeerBots.push({
      alias: 'Hermes',
      openId: 'ou_hermes',
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_bot',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: '@Bridge 部署完成，请验证',
        rawSenderType: 'bot',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
        rawMentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot' },
            mentioned_type: 'bot',
            name: 'Bridge',
          },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    const context = readSection(prompt, 'bridge_context') as {
      senderType?: string;
      senderId?: string;
      botOpenId?: string;
      mentions?: unknown[];
    };
    expect(context).toMatchObject({ senderType: 'bot', senderId: '@Hermes' });
    expect(context).not.toHaveProperty('botOpenId');
    expect(context).not.toHaveProperty('mentions');
    expect(prompt).toContain('@Hermes');
    expect(prompt).not.toContain('ou_hermes');
  });

  it('marks a human sender via raw sender_type', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_user',
        content: '@Bridge 帮我看个问题',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
    };
    expect(context.senderType).toBe('user');
  });

  it('silently drops untrusted, indirect, and Bot Command traffic', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    h.profileConfig.collaboration.trustedPeerBots.push({
      alias: 'Hermes',
      openId: 'ou_hermes',
    });
    await startTestBridge(h);

    const directMention = [
      {
        key: '@_user_1',
        id: { open_id: 'ou_bot' },
        mentioned_type: 'bot',
        name: 'Bridge',
      },
    ];
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_untrusted',
        senderId: 'ou_unknown_bot',
        content: 'untrusted',
        rawSenderType: 'bot',
        rawMentions: directMention,
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_indirect',
        senderId: 'ou_hermes',
        content: '@Bridge text only',
        rawSenderType: 'bot',
        rawMentions: [],
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_bot_command',
        senderId: 'ou_hermes',
        content: '/config',
        rawSenderType: 'bot',
        rawMentions: directMention,
      }),
    );
    await vi.advanceTimersByTimeAsync(800);

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('silently drops traffic whose sender identity is unavailable', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_raw',
        content: '@Bridge 在吗',
        normalizedSenderType: 'bot',
      }),
    );
    await vi.advanceTimersByTimeAsync(800);

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('turns a mention-only message into an explicit wake-up ping', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_empty_at',
        content: '',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('唤醒');
    expect(userInput.text).toContain('没有正文');
  });

  it('runs peer messages independently and in arrival order', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.trustedPeerBots.push({
      alias: 'Hermes',
      openId: 'ou_hermes',
    });
    await startTestBridge(h);

    for (const [messageId, content] of [
      ['om_peer_first', 'first peer request'],
      ['om_peer_second', 'second peer request'],
    ]) {
      await h.channel.handlers.message?.(
        message({
          messageId,
          senderId: 'ou_hermes',
          senderName: 'HermesBot',
          content,
          rawSenderType: 'bot',
          mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
          rawMentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_bot' },
              mentioned_type: 'bot',
              name: 'Bridge',
            },
          ],
        }),
      );
    }
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[0]?.prompt).toContain('first peer request');
    expect(h.agent.runOptions[1]?.prompt).toContain('second peer request');
    expect(h.agent.runOptions[0]?.prompt).not.toContain('second peer request');
  });

  it('keeps single-message batches free of sender annotations', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_single',
        content: '@Bridge 看下这个',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).not.toContain('[User (user)]:');
    expect(userInput.text).toContain('看下这个');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('bot-at-bot-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    app: {
      id: 'cli_test',
      secret: 'secret',
      tenant: 'feishu',
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
    },
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
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
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
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
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
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream() {},
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  normalizedSenderType?: string;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
  rawMentions?: Array<{
    key: string;
    id: { open_id: string };
    mentioned_type: string;
    name: string;
  }>;
  mentionedBot?: boolean;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    ...(input.normalizedSenderType
      ? {
          senderType: input.normalizedSenderType,
          senderIsBot: input.normalizedSenderType === 'bot',
        }
      : {}),
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [
      { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
    ],
    mentionAll: false,
    mentionedBot: input.mentionedBot ?? true,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: {
              message_id: input.messageId,
              ...(input.rawMentions ? { mentions: input.rawMentions } : {}),
            },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
