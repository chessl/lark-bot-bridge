import type { NormalizedMessage } from '@larksuite/channel';
import type { RunState } from '../card/run-state';

export type VerifiedHumanId = string & { readonly __brand: 'VerifiedHumanId' };
export type VerifiedBotId = string & { readonly __brand: 'VerifiedBotId' };

export type ImIdentityReason =
  | 'missing-raw-sender'
  | 'missing-sender-id'
  | 'contradictory-sender-id'
  | 'unknown-sender-type';

export type ImSenderIdentity =
  | Readonly<{ kind: 'human'; id: VerifiedHumanId }>
  | Readonly<{ kind: 'bot'; id: VerifiedBotId }>
  | Readonly<{ kind: 'unknown'; reason: ImIdentityReason }>;

export type ImConversationScope =
  | Readonly<{
      kind: 'chat';
      id: string;
      chatId: string;
      mode: 'p2p' | 'group' | 'topic';
    }>
  | Readonly<{
      kind: 'topic';
      id: string;
      chatId: string;
      threadId: string;
      mode: 'topic';
    }>;

export type ImReplyTarget =
  | Readonly<{
      chatId: string;
      messageId: string;
      replyInThread: false;
    }>
  | Readonly<{
      chatId: string;
      messageId: string;
      threadId: string;
      replyInThread: true;
    }>;

export type ImRouteReason =
  | 'access-denied'
  | 'duplicate-message'
  | 'mention-required'
  | 'human-command'
  | 'ordinary-message';

export type ImPromptReason = 'ordinary-message-batch';

export type ImReplyReason =
  | 'run-completed'
  | 'run-failed'
  | 'run-interrupted'
  | 'run-timed-out';

export interface PlanImMessageInput {
  message: NormalizedMessage;
  scope: ImConversationScope;
  authorized: boolean;
  duplicate: boolean;
  mentionRequired: boolean;
  recognizedCommand: boolean;
}

export type ImMessagePlan = ImDroppedMessagePlan | ImCommandPlan | ImOrdinaryMessagePlan;

export type ImDroppedMessagePlan = Readonly<{
  lane: 'drop';
  reason: Extract<ImRouteReason, 'access-denied' | 'duplicate-message' | 'mention-required'>;
}>;

export type ImCommandPlan = Readonly<{
  lane: 'command';
  reason: 'human-command';
  scope: ImConversationScope;
  source: ImSourceMessage;
}>;

export type ImOrdinaryMessagePlan = Readonly<{
  lane: 'ordinary';
  reason: 'ordinary-message';
  scope: ImConversationScope;
  source: ImSourceMessage;
}>;

export type ImSourceMessage = Readonly<{
  message: NormalizedMessage;
  sender: ImSenderIdentity;
}>;

export type ImPromptMessage = Readonly<{
  messageId: string;
  senderId: string;
  senderName?: string;
  sender: ImSenderIdentity;
  content: string;
  resourceFileKeys: readonly string[];
  mentions: ReadonlyArray<{
    key: string;
    openId?: string;
    name?: string;
    isBot?: boolean;
  }>;
  interactiveCard?: unknown;
}>;

export type ImPromptPolicy = Readonly<{
  kind: 'ordinary';
  reason: ImPromptReason;
  messages: readonly [ImPromptMessage, ...ImPromptMessage[]];
  botIdentity?: Readonly<{ openId: string; name?: string }>;
}>;

export type ImInvocation = Readonly<{
  kind: 'ordinary';
  routeReason: 'ordinary-message';
  scope: ImConversationScope;
  sourceMessages: readonly [ImSourceMessage, ...ImSourceMessage[]];
  replyTarget: ImReplyTarget;
  promptPolicy: ImPromptPolicy;
}>;

export type ImReplyPlan = Readonly<{
  invocationKind: ImInvocation['kind'];
  reason: ImReplyReason;
  scope: ImConversationScope;
  target: ImReplyTarget;
  state: RunState;
}>;

export function planImMessage(input: PlanImMessageInput): ImMessagePlan {
  if (!input.authorized) return Object.freeze({ lane: 'drop', reason: 'access-denied' });
  if (input.duplicate) return Object.freeze({ lane: 'drop', reason: 'duplicate-message' });
  if (input.mentionRequired) return Object.freeze({ lane: 'drop', reason: 'mention-required' });

  const source = snapshotSource(input.message);
  const scope = snapshotScope(input.scope);
  if (input.recognizedCommand && source.sender.kind === 'human') {
    return Object.freeze({
      lane: 'command',
      reason: 'human-command',
      scope,
      source,
    });
  }
  return Object.freeze({
    lane: 'ordinary',
    reason: 'ordinary-message',
    scope,
    source,
  });
}

export function createImInvocation(
  plans: readonly [ImOrdinaryMessagePlan, ...ImOrdinaryMessagePlan[]],
  botIdentity?: Readonly<{ openId: string; name?: string }>,
): ImInvocation {
  const first = plans[0];
  const seen = new Set<string>();
  const sources: ImSourceMessage[] = [];
  for (const plan of plans) {
    if (plan.scope.id !== first.scope.id) {
      throw new Error('ordinary IM batch crossed Conversation Scope');
    }
    if (seen.has(plan.source.message.messageId)) continue;
    seen.add(plan.source.message.messageId);
    sources.push(plan.source);
  }

  const sourceMessages = nonEmpty(sources);
  const [firstSource, ...remainingSources] = sourceMessages;
  const last = remainingSources[remainingSources.length - 1] ?? firstSource;
  const promptMessages = nonEmpty(sourceMessages.map(toPromptMessage));
  return Object.freeze({
    kind: 'ordinary',
    routeReason: 'ordinary-message',
    scope: first.scope,
    sourceMessages: Object.freeze(sourceMessages),
    replyTarget: replyTarget(last.message),
    promptPolicy: Object.freeze({
      kind: 'ordinary',
      reason: 'ordinary-message-batch',
      messages: Object.freeze(promptMessages),
      ...(botIdentity
        ? {
            botIdentity: Object.freeze({
              openId: botIdentity.openId,
              ...(botIdentity.name ? { name: botIdentity.name } : {}),
            }),
          }
        : {}),
    }),
  });
}

export function finalizeImReply(invocation: ImInvocation, state: RunState): ImReplyPlan {
  let reason: ImReplyReason;
  switch (state.terminal) {
    case 'done':
      reason = 'run-completed';
      break;
    case 'error':
      reason = 'run-failed';
      break;
    case 'interrupted':
      reason = 'run-interrupted';
      break;
    case 'idle_timeout':
      reason = 'run-timed-out';
      break;
    case 'running':
      throw new Error('cannot finalize a running IM Invocation');
    default: {
      const exhaustive: never = state.terminal;
      throw new Error(`unknown IM termination: ${exhaustive}`);
    }
  }
  return Object.freeze({
    invocationKind: invocation.kind,
    reason,
    scope: invocation.scope,
    target: invocation.replyTarget,
    state,
  });
}

function snapshotSource(message: NormalizedMessage): ImSourceMessage {
  const resources = message.resources.map((resource) => Object.freeze({ ...resource }));
  const mentions = (message.mentions ?? []).map((mention) => Object.freeze({ ...mention }));
  Object.freeze(resources);
  Object.freeze(mentions);
  const snapshot: NormalizedMessage = {
    ...message,
    resources,
    mentions,
    ...(message.raw === undefined ? {} : { raw: structuredClone(message.raw) }),
  };
  Object.freeze(snapshot);
  return Object.freeze({ message: snapshot, sender: parseSender(message) });
}

function parseSender(message: NormalizedMessage): ImSenderIdentity {
  const raw = message.raw;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('sender' in raw) ||
    typeof raw.sender !== 'object' ||
    raw.sender === null
  ) {
    return Object.freeze({ kind: 'unknown', reason: 'missing-raw-sender' });
  }
  const rawSender = raw.sender;
  if (
    !('sender_id' in rawSender) ||
    typeof rawSender.sender_id !== 'object' ||
    rawSender.sender_id === null ||
    !('open_id' in rawSender.sender_id) ||
    typeof rawSender.sender_id.open_id !== 'string'
  ) {
    return Object.freeze({ kind: 'unknown', reason: 'missing-sender-id' });
  }
  const rawId = rawSender.sender_id.open_id;
  if (!rawId || !message.senderId) {
    return Object.freeze({ kind: 'unknown', reason: 'missing-sender-id' });
  }
  if (rawId !== message.senderId) {
    return Object.freeze({ kind: 'unknown', reason: 'contradictory-sender-id' });
  }
  const senderType = 'sender_type' in rawSender ? rawSender.sender_type : undefined;
  if (senderType === 'user') {
    return Object.freeze({ kind: 'human', id: verifiedHumanId(rawId) });
  }
  if (senderType === 'app' || senderType === 'bot') {
    return Object.freeze({ kind: 'bot', id: verifiedBotId(rawId) });
  }
  return Object.freeze({ kind: 'unknown', reason: 'unknown-sender-type' });
}

function toPromptMessage(source: ImSourceMessage): ImPromptMessage {
  const message = source.message;
  const interactiveCard = readInteractiveCard(message);
  return Object.freeze({
    messageId: message.messageId,
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    sender: source.sender,
    content: message.content,
    resourceFileKeys: Object.freeze(message.resources.map((resource) => resource.fileKey)),
    mentions: Object.freeze(
      (message.mentions ?? []).map((mention) =>
        Object.freeze({
          key: mention.key,
          ...(mention.openId ? { openId: mention.openId } : {}),
          ...(mention.name ? { name: mention.name } : {}),
          ...(mention.isBot === undefined ? {} : { isBot: mention.isBot }),
        }),
      ),
    ),
    ...(interactiveCard === undefined ? {} : { interactiveCard }),
  });
}

function readInteractiveCard(message: NormalizedMessage): unknown {
  const raw = message.raw;
  if (
    message.rawContentType !== 'interactive' ||
    typeof raw !== 'object' ||
    raw === null ||
    !('message' in raw) ||
    typeof raw.message !== 'object' ||
    raw.message === null ||
    !('content' in raw.message) ||
    typeof raw.message.content !== 'string' ||
    !raw.message.content
  ) {
    return undefined;
  }
  try {
    return JSON.parse(raw.message.content) as unknown;
  } catch {
    return raw.message.content;
  }
}

function snapshotScope(scope: ImConversationScope): ImConversationScope {
  return scope.kind === 'topic'
    ? Object.freeze({
        kind: scope.kind,
        id: scope.id,
        chatId: scope.chatId,
        threadId: scope.threadId,
        mode: scope.mode,
      })
    : Object.freeze({
        kind: scope.kind,
        id: scope.id,
        chatId: scope.chatId,
        mode: scope.mode,
      });
}

function replyTarget(message: NormalizedMessage): ImReplyTarget {
  if (message.threadId) {
    return Object.freeze({
      chatId: message.chatId,
      messageId: message.messageId,
      threadId: message.threadId,
      replyInThread: true,
    });
  }
  return Object.freeze({
    chatId: message.chatId,
    messageId: message.messageId,
    replyInThread: false,
  });
}

function nonEmpty<T>(items: readonly T[]): [T, ...T[]] {
  const first = items[0];
  if (first === undefined) {
    throw new Error('IM Invocation requires at least one source message');
  }
  return [first, ...items.slice(1)];
}

function verifiedHumanId(value: string): VerifiedHumanId {
  return value as VerifiedHumanId;
}

function verifiedBotId(value: string): VerifiedBotId {
  return value as VerifiedBotId;
}

