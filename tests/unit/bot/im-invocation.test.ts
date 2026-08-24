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
  it.each(
    [
      {
        name: 'verified human',
        senderType: 'user',
        rawSenderId: 'ou_sender',
        expected: { kind: 'human', id: 'ou_sender' },
      },
      {
        name: 'verified bot',
        senderType: 'app',
        rawSenderId: 'ou_sender',
        expected: { kind: 'bot', id: 'ou_sender' },
      },
      {
        name: 'missing raw sender',
        senderType: undefined,
        rawSenderId: undefined,
        expected: { kind: 'unknown', reason: 'missing-raw-sender' },
      },
      {
        name: 'missing raw sender ID',
        senderType: 'user',
        rawSenderId: undefined,
        expected: { kind: 'unknown', reason: 'missing-sender-id' },
      },
      {
        name: 'contradictory sender ID',
        senderType: 'user',
        rawSenderId: 'ou_other',
        expected: { kind: 'unknown', reason: 'contradictory-sender-id' },
      },
      {
        name: 'unknown sender type',
        senderType: 'tenant',
        rawSenderId: 'ou_sender',
        expected: { kind: 'unknown', reason: 'unknown-sender-type' },
      },
      {
        name: 'contradictory sender type',
        senderType: 'user',
        normalizedSenderType: 'bot',
        rawSenderId: 'ou_sender',
        expected: { kind: 'unknown', reason: 'contradictory-sender-type' },
      },
      {
        name: 'contradictory app bot marker',
        senderType: 'app',
        normalizedSenderIsBot: false,
        rawSenderId: 'ou_sender',
        expected: { kind: 'unknown', reason: 'contradictory-sender-type' },
      },
    ] satisfies Array<{
      name: string;
      senderType: string | undefined;
      normalizedSenderType?: string;
      normalizedSenderIsBot?: boolean;
      rawSenderId: string | undefined;
      expected: object;
    }>,
  )(
    'keeps $name explicit',
    ({ name, senderType, normalizedSenderType, normalizedSenderIsBot, rawSenderId, expected }) => {
      const message = imMessage({
        messageId: `om_${name}`,
        ...(senderType === undefined ? {} : { senderType }),
        ...(normalizedSenderType === undefined ? {} : { normalizedSenderType }),
        ...(normalizedSenderIsBot === undefined ? {} : { normalizedSenderIsBot }),
        ...(rawSenderId === undefined ? {} : { rawSenderId }),
      });
      const plan = ordinaryPlan(message, CHAT_SCOPE);

      expect(plan.source.sender).toEqual(expected);
    },
  );

  it('applies access, duplicate, mention, and human Command precedence in that order', () => {
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
    expect(planImMessage({ ...base, mentionRequired: true }).reason).toBe('mention-required');
    expect(planImMessage(base)).toMatchObject({ lane: 'command', reason: 'human-command' });

    const botCommand = planImMessage({
      ...base,
      message: imMessage({ senderType: 'app', rawSenderId: 'ou_sender' }),
    });
    expect(botCommand).toMatchObject({ lane: 'ordinary', reason: 'ordinary-message' });
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
    normalizedSenderIsBot?: boolean;
    threadId?: string;
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
          senderIsBot:
            input.normalizedSenderIsBot ??
            (normalizedSenderType === 'app' || normalizedSenderType === 'bot'),
        }
      : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    content: input.content ?? 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
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
          },
        }),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  } as unknown as NormalizedMessage;
}
