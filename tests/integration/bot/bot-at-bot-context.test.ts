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

  it('maps a human structured peer Mention to its frozen alias without leaking the peer ID', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.trustedPeerBots.push({
      alias: 'Hermes',
      openId: 'ou_hermes',
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_human_peer_mention',
        content: '请协助处理',
        rawSenderType: 'user',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
          { key: '@_user_2', openId: 'ou_hermes', name: 'HermesBot', isBot: true },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    const context = readSection(prompt, 'bridge_context') as {
      mentions?: Array<{ name?: string; openId?: string; isBot?: boolean }>;
    };
    expect(context.mentions).toContainEqual({ name: '@Hermes', isBot: true });
    expect(prompt).toContain('@Hermes');
    expect(prompt).not.toContain('ou_hermes');
  });
  it('freezes the live collaboration policy when the ordinary batch becomes an Invocation', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_policy',
        content: '请协作处理',
        rawSenderType: 'user',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
          { key: '@_user_2', openId: 'ou_atlas', name: 'AtlasBot', isBot: true },
          { key: '@_user_3', openId: 'ou_target', name: 'Target label', isBot: false },
        ],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }],
      }),
    );
    h.controls.cfg.collaboration.trustedPeerBots = [{ alias: 'Atlas', openId: 'ou_atlas' }];
    h.controls.cfg.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(h.agent.runOptions).toHaveLength(1));

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('@Atlas');
    expect(prompt).toContain('Target label');
    expect(prompt).not.toMatch(/ou_(?:atlas|target)/);
  });

  it('does not waive requireMention from normalized mentionedBot alone', async () => {
    vi.useFakeTimers();
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_normalized_only',
        content: 'normalized mention only',
        rawSenderType: 'user',
        rawMentions: [],
        mentionedBot: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(800);

    expect(h.agent.runOptions).toHaveLength(0);
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

  it('admits concurrent peer messages in arrival order before async scope resolution', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.trustedPeerBots.push({
      alias: 'Hermes',
      openId: 'ou_hermes',
    });
    const modeGate = Promise.withResolvers<void>();
    const firstLookupStarted = Promise.withResolvers<void>();
    let modeLookups = 0;
    h.channel.getChatMode = async () => {
      modeLookups++;
      if (modeLookups === 1) {
        firstLookupStarted.resolve();
        await modeGate.promise;
      }
      return 'group';
    };
    await startTestBridge(h);

    const peerMessages: [NormalizedMessage, NormalizedMessage] = [
      message({
        messageId: 'om_peer_first',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: 'first peer request',
        rawSenderType: 'bot',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }],
      }),
      message({
        messageId: 'om_peer_second',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: 'second peer request',
        rawSenderType: 'bot',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }],
      }),
    ];
    const [firstMessage, secondMessage] = peerMessages;
    const first = h.channel.handlers.message?.(firstMessage);
    await firstLookupStarted.promise;
    const second = h.channel.handlers.message?.(secondMessage);
    const lookupsBeforeRelease = modeLookups;
    modeGate.resolve();
    await Promise.all([first, second]);
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(lookupsBeforeRelease).toBe(1);
    expect(modeLookups).toBe(1);
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

describe('personal substitution intake', () => {
  it('gives access, Command, and current-Bot Mention priority over substitution', async () => {
    vi.useFakeTimers();
    const denied = await createHarness();
    denied.profileConfig.access.allowedChats = [];
    denied.profileConfig.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    await startTestBridge(denied);
    await denied.channel.handlers.message?.(
      message({
        messageId: 'om_denied_substitution',
        content: 'denied',
        rawSenderType: 'user',
        mentionedBot: false,
        mentions: [{ key: '@_user_1', openId: 'ou_target', name: 'Target', isBot: false }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_target' }, name: 'Target' }],
      }),
    );
    await vi.advanceTimersByTimeAsync(800);
    expect(denied.agent.runOptions).toHaveLength(0);

    vi.useRealTimers();
    const h = await createHarness();
    h.profileConfig.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_command_substitution',
        content: '/help',
        rawSenderType: 'user',
        mentionedBot: false,
        mentions: [{ key: '@_user_1', openId: 'ou_target', name: 'Target', isBot: false }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_target' }, name: 'Target' }],
      }),
    );
    expect(h.agent.runOptions).toHaveLength(0);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_current_bot_priority',
        content: 'Bridge handles this',
        rawSenderType: 'user',
        mentionedBot: true,
        mentions: [
          { key: '@_user_1', openId: 'ou_target', name: 'Target', isBot: false },
          { key: '@_user_2', openId: 'ou_bot', name: 'Bridge', isBot: true },
        ],
        rawMentions: [
          { key: '@_user_1', id: { open_id: 'ou_target' }, name: 'Target' },
          { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Bridge' },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).not.toContain('personal substitution');
  });

  it('freezes exact target and display label per isolated Chat Invocation', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_substitution_old',
        content: '@Target answer this',
        rawSenderType: 'user',
        mentionedBot: false,
        mentions: [{ key: '@_user_1', openId: 'ou_target', name: 'Event label', isBot: false }],
        rawMentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_target' },
            name: 'Config spoof',
          },
        ],
      }),
    );
    h.controls.cfg.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_next'],
    };
    await waitFor(() => h.agent.runOptions.length === 1);
    const firstPrompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(firstPrompt).toContain('Event label');
    expect(firstPrompt).not.toContain('Config spoof');
    expect(firstPrompt).not.toContain('ou_target');

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_substitution_stale',
        content: 'old target',
        rawSenderType: 'user',
        mentionedBot: false,
        mentions: [{ key: '@_user_1', openId: 'ou_target', name: 'Old', isBot: false }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_target' }, name: 'Old' }],
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_substitution_next',
        content: 'new target',
        rawSenderType: 'user',
        mentionedBot: false,
        mentions: [{ key: '@_user_1', openId: 'ou_next', name: 'Next', isBot: false }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_next' }, name: 'Next' }],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.prompt).toContain('new target');
    expect(h.agent.runOptions[1]?.prompt).not.toContain('old target');
  });

  it('sends one Mention-free Topic control Reply and no Run when every target is invalid', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    const send = vi.spyOn(h.channel, 'send');
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_all_invalid',
        content: '@Private invalid targets',
        rawSenderType: 'user',
        mentionedBot: false,
        threadId: 'omt_topic',
        mentions: [
          { key: '@_user_1', openId: 'ou_user', name: 'Self secret', isBot: false },
          { key: '@_user_2', openId: 'ou_unknown', name: 'Unknown secret', isBot: false },
        ],
        rawMentions: [
          { key: '@_user_1', id: { open_id: 'ou_user' }, name: 'Self secret' },
          { key: '@_user_2', id: { open_id: 'ou_unknown' }, name: 'Unknown secret' },
        ],
      }),
    );

    expect(h.agent.runOptions).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'oc_chat',
      { text: '无法确认这 2 个代答对象的身份，未启动代答。' },
      { replyTo: 'om_all_invalid', replyInThread: true },
    );
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/ou_|secret|<at/i);
  });
  it('keeps substitution isolated from ordinary batching and preserves Topic scope', async () => {
    const h = await createHarness();
    h.profileConfig.collaboration.personalSubstitution = {
      enabled: true,
      targetOpenIds: ['ou_target'],
    };
    await startTestBridge(h);
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_substitution',
        content: 'isolated substitution',
        rawSenderType: 'user',
        mentionedBot: false,
        threadId: 'omt_topic',
        mentions: [{ key: '@_user_1', openId: 'ou_target', name: 'Target', isBot: false }],
        rawMentions: [{ key: '@_user_1', id: { open_id: 'ou_target' }, name: 'Target' }],
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_ordinary',
        content: 'ordinary follow-up',
        rawSenderType: 'user',
        threadId: 'omt_topic',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.agent.runOptions[0]?.prompt).toContain('isolated substitution');
    expect(h.agent.runOptions[0]?.prompt).not.toContain('ordinary follow-up');
    expect(h.agent.runOptions[1]?.prompt).toContain('ordinary follow-up');
    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      threadId?: string;
    };
    expect(context.threadId).toBe('omt_topic');
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
    name: string;
    mentioned_type?: string;
  }>;
  threadId?: string;
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
              mentions:
                input.rawMentions ??
                (input.mentionedBot === false
                  ? []
                  : [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }]),
            },
          },
        }
      : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
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
