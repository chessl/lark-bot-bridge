import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  createImInvocation,
  finalizeImReply,
  type ImConversationScope,
  type ImOrdinaryMessagePlan,
  planImMessage,
} from '../../../src/bot/im-invocation.js';
import {
  createRunState,
  finalizeIfRunning,
  markIdleTimeout,
  markInterrupted,
  type RunState,
} from '../../../src/card/run-state.js';

const CHAT_SCOPE: ImConversationScope = {
  kind: 'chat',
  id: 'oc_chat',
  chatId: 'oc_chat',
  mode: 'group',
};

const TOPIC_SCOPE: ImConversationScope = {
  kind: 'topic',
  id: 'oc_chat:omt_topic',
  chatId: 'oc_chat',
  threadId: 'omt_topic',
  mode: 'topic',
};
const P2P_SCOPE: ImConversationScope = {
  kind: 'chat',
  id: 'oc_chat',
  chatId: 'oc_chat',
  mode: 'p2p',
};


describe('IM message planning', () => {
  it('keeps a verified human identity on ordinary traffic', () => {
    const plan = ordinaryPlan(
      imMessage({ senderType: 'user', rawSenderId: 'ou_sender' }),
      CHAT_SCOPE,
    );
    expect(plan.source.sender).toEqual({ kind: 'human', id: 'ou_sender' });
  });

  it.each([
    {
      name: 'missing raw sender',
      message: imMessage({ normalizedSenderType: 'bot' }),
      reason: 'unknown-sender',
    },
    {
      name: 'contradictory sender ID',
      message: imMessage({
        senderType: 'bot',
        normalizedSenderType: 'bot',
        rawSenderId: 'ou_other',
      }),
      reason: 'unknown-sender',
    },
    {
      name: 'contradictory sender type',
      message: imMessage({
        senderType: 'user',
        normalizedSenderType: 'bot',
        rawSenderId: 'ou_sender',
      }),
      reason: 'unknown-sender',
    },
  ])('drops $name without constructing a privileged lane', ({ message, reason }) => {
    expect(
      planImMessage({
        message,
        scope: CHAT_SCOPE,
        authorized: true,
        duplicate: false,
        mentionRequired: false,
        recognizedCommand: false,
      }),
    ).toMatchObject({ lane: 'drop', reason, allowAccessHint: false });
  });

  it.each([
    {
      name: 'trusted direct peer',
      senderId: 'ou_peer',
      rawMention: true,
      normalizedIsBot: true,
      trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
      content: 'please review',
      expected: { lane: 'peer', reason: 'trusted-peer' },
    },
    {
      name: 'untrusted direct Bot',
      senderId: 'ou_other',
      rawMention: true,
      normalizedIsBot: true,
      trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
      content: 'please review',
      expected: { lane: 'drop', reason: 'untrusted-bot' },
    },
    {
      name: 'indirect trusted Bot',
      senderId: 'ou_peer',
      rawMention: false,
      normalizedIsBot: true,
      trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
      content: '@Bridge as text only',
      expected: { lane: 'drop', reason: 'bot-not-direct-mention' },
    },
    {
      name: 'contradictory normalized Mention kind',
      senderId: 'ou_peer',
      rawMention: true,
      normalizedIsBot: false,
      trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
      content: 'please review',
      expected: { lane: 'drop', reason: 'contradictory-mention' },
    },
    {
      name: 'Bot Command',
      senderId: 'ou_peer',
      rawMention: true,
      normalizedIsBot: true,
      trustedPeerBots: [{ alias: 'Hermes', openId: 'ou_peer' }],
      content: '/config',
      expected: { lane: 'drop', reason: 'bot-command' },
    },
  ])(
    'routes $name from verified identity and structured current-Bot Mention only',
    ({ senderId, rawMention, normalizedIsBot, trustedPeerBots, content, expected }) => {
      const plan = planImMessage({
        message: imMessage({
          senderId,
          senderType: 'bot',
          rawSenderId: senderId,
          content,
          mentions: [
            {
              key: '@_user_1',
              openId: 'ou_bot',
              name: 'Bridge',
              isBot: normalizedIsBot,
            },
          ],
          rawMentions: rawMention ? [{ id: { open_id: 'ou_bot' } }] : [],
          mentionedBot: normalizedIsBot,
        }),
        scope: CHAT_SCOPE,
        authorized: true,
        duplicate: false,
        mentionRequired: false,
        recognizedCommand: content === '/config',
        currentBotOpenId: 'ou_bot',
        trustedPeerBots,
      });
      expect(plan).toMatchObject(expected);
    },
  );

  it('applies access, duplicate, human Command, then mention policy precedence', () => {
    const message = imMessage({ senderType: 'user', rawSenderId: 'ou_sender' });
    const base = {
      message,
      scope: CHAT_SCOPE,
      authorized: true,
      duplicate: false,
      mentionRequired: false,
      recognizedCommand: true,
    };

    expect(planImMessage({ ...base, authorized: false, duplicate: true }).reason).toBe(
      'access-denied',
    );
    expect(planImMessage({ ...base, duplicate: true, mentionRequired: true }).reason).toBe(
      'duplicate-message',
    );
    expect(planImMessage({ ...base, mentionRequired: true }).reason).toBe('human-command');
  });
});

describe('ordinary IM Invocation creation', () => {
  it('freezes a deduplicated batch, prompt policy, Conversation Scope, and last Reply target', () => {
    const firstMessage = imMessage({
      messageId: 'om_first',
      content: 'first',
      senderId: 'ou_first',
      senderName: 'First',
      senderType: 'user',
      rawSenderId: 'ou_first',
      threadId: 'omt_topic',
    });
    const duplicate = imMessage({
      messageId: 'om_first',
      content: 'duplicate delivery',
      senderId: 'ou_first',
      senderType: 'user',
      rawSenderId: 'ou_first',
      threadId: 'omt_topic',
    });
    const lastMessage = imMessage({
      messageId: 'om_last',
      content: 'last',
      senderId: 'ou_second',
      senderName: 'Second',
      senderType: 'user',
      rawSenderId: 'ou_second',
      threadId: 'omt_topic',
    });
    const invocation = createImInvocation(
      [
        ordinaryPlan(firstMessage, TOPIC_SCOPE),
        ordinaryPlan(duplicate, TOPIC_SCOPE),
        ordinaryPlan(lastMessage, TOPIC_SCOPE),
      ],
      { openId: 'ou_bot', name: 'Bridge' },
    );
    firstMessage.content = 'mutated after planning';

    expect(invocation.kind).toBe('ordinary');
    expect(invocation.scope).toEqual(TOPIC_SCOPE);
    expect(invocation.sourceMessages.map(({ message }) => message.messageId)).toEqual([
      'om_first',
      'om_last',
    ]);
    expect(invocation.sourceMessages[0].message.content).toBe('first');
    expect(invocation.promptPolicy).toMatchObject({
      kind: 'ordinary',
      reason: 'ordinary-message-batch',
      botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    });
    expect(invocation.promptPolicy.messages.map(({ senderName }) => senderName)).toEqual([
      'First',
      'Second',
    ]);
    expect(invocation.replyTarget).toEqual({
      chatId: 'oc_chat',
      messageId: 'om_last',
      threadId: 'omt_topic',
      replyInThread: true,
    });
    expect(invocation.replyPolicy).toEqual({
      invocationKind: 'ordinary',
      scope: TOPIC_SCOPE,
      target: invocation.replyTarget,
      senderOwnership: { kind: 'mention', openId: 'ou_second' },
    });
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.sourceMessages)).toBe(true);
  });

  it('freezes a verified P2P human as the terminal sender owner', () => {
    const invocation = createImInvocation([
      ordinaryPlan(
        imMessage({ senderType: 'user', rawSenderId: 'ou_sender' }),
        P2P_SCOPE,
      ),
    ]);

    expect(invocation.replyPolicy.senderOwnership).toEqual({
      kind: 'mention',
      openId: 'ou_sender',
    });
  });
});

describe('peer IM Invocation creation', () => {
  it('freezes alias policy, keeps Topic target, and projects no canonical peer IDs', () => {
    const trustedPeerBots = [
      { alias: 'Hermes', openId: 'ou_peer' },
      { alias: 'Atlas', openId: 'ou_atlas' },
    ];
    const plan = planImMessage({
      message: imMessage({
        messageId: 'om_peer',
        senderId: 'ou_peer',
        senderType: 'bot',
        rawSenderId: 'ou_peer',
        threadId: 'omt_topic',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
        rawMentions: [{ id: { open_id: 'ou_bot' } }],
      }),
      scope: TOPIC_SCOPE,
      authorized: true,
      duplicate: false,
      mentionRequired: false,
      recognizedCommand: false,
      currentBotOpenId: 'ou_bot',
      trustedPeerBots,
    });
    if (plan.lane !== 'peer') throw new Error(`expected peer plan, got ${plan.lane}`);

    trustedPeerBots[0] = { alias: 'Changed', openId: 'ou_changed' };
    const invocation = createImInvocation([plan]);

    expect(invocation).toMatchObject({
      kind: 'peer',
      peerAlias: 'Hermes',
      scope: TOPIC_SCOPE,
      replyTarget: {
        messageId: 'om_peer',
        threadId: 'omt_topic',
        replyInThread: true,
      },
      replyPolicy: {
        invocationKind: 'peer',
        senderOwnership: { kind: 'none', reason: 'verified-bot-sender' },
      },
      promptPolicy: {
        kind: 'peer',
        reason: 'trusted-peer-message',
        trustedPeerAliases: ['Hermes', 'Atlas'],
        zeroHop: true,
      },
    });
    expect(JSON.stringify(invocation.promptPolicy)).not.toContain('ou_peer');
    expect(JSON.stringify(invocation.promptPolicy)).not.toContain('ou_atlas');
    expect(Object.isFrozen(invocation.trustedPeers)).toBe(true);
  });
});

describe('IM Reply planning', () => {
  it.each(
    [
      {
        name: 'done',
        state: {
          ...finalizeIfRunning(createRunState()),
          finalText: 'answer',
        } satisfies RunState,
        reason: 'run-completed',
      },
      { name: 'empty done', state: finalizeIfRunning(createRunState()), reason: 'run-completed' },
      {
        name: 'error',
        state: { ...createRunState(), terminal: 'error' } satisfies RunState,
        reason: 'run-failed',
      },
      {
        name: 'interrupted',
        state: markInterrupted(createRunState()),
        reason: 'run-interrupted',
      },
      {
        name: 'idle timeout',
        state: markIdleTimeout(createRunState()),
        reason: 'run-timed-out',
      },
    ] satisfies Array<{ name: string; state: RunState; reason: string }>,
  )('maps $name termination to one finite reason', ({ state, reason }) => {
    const invocation = createImInvocation([
      ordinaryPlan(
        imMessage({ senderType: 'user', rawSenderId: 'ou_sender' }),
        CHAT_SCOPE,
      ),
    ]);

    expect(finalizeImReply(invocation, state)).toMatchObject({
      invocationKind: 'ordinary',
      reason,
      scope: CHAT_SCOPE,
      target: { messageId: 'om_message' },
      state,
      senderOwnership: { kind: 'mention', openId: 'ou_sender' },
    });
  });

  it('rejects a non-terminal Run state', () => {
    const invocation = createImInvocation([
      ordinaryPlan(
        imMessage({ senderType: 'user', rawSenderId: 'ou_sender' }),
        CHAT_SCOPE,
      ),
    ]);

    expect(() => finalizeImReply(invocation, createRunState())).toThrow(
      'cannot finalize a running IM Invocation',
    );
  });
});

function ordinaryPlan(
  message: NormalizedMessage,
  scope: ImConversationScope,
): ImOrdinaryMessagePlan {
  const plan = planImMessage({
    message,
    scope,
    authorized: true,
    duplicate: false,
    mentionRequired: false,
    recognizedCommand: false,
  });
  if (plan.lane !== 'ordinary') throw new Error(`expected ordinary plan, got ${plan.lane}`);
  return plan;
}

function imMessage(
  input: {
    messageId?: string;
    content?: string;
    senderId?: string;
    senderName?: string;
    senderType?: string;
    rawSenderId?: string;
    normalizedSenderType?: string;
    threadId?: string;
    mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
    rawMentions?: Array<{
      id: { open_id: string };
    }>;
    mentionedBot?: boolean;
  } = {},
): NormalizedMessage {
  const senderId = input.senderId ?? 'ou_sender';
  const normalizedSenderType = input.normalizedSenderType ?? input.senderType;
  return {
    messageId: input.messageId ?? 'om_message',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId,
    ...(normalizedSenderType
      ? {
          senderType: normalizedSenderType,
          senderIsBot: normalizedSenderType === 'bot',
        }
      : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    content: input.content ?? 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [],
    mentionAll: false,
    mentionedBot: input.mentionedBot ?? true,
    createTime: 1760000001000,
    ...(input.senderType === undefined
      ? {}
      : {
          raw: {
            sender: {
              sender_type: input.senderType,
              ...(input.rawSenderId === undefined
                ? {}
                : { sender_id: { open_id: input.rawSenderId } }),
            },
            ...(input.rawMentions ? { message: { mentions: input.rawMentions } } : {}),
          },
        }),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  } as unknown as NormalizedMessage;
}
