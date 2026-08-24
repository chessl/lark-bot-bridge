import type { NormalizedMessage } from '@larksuite/channel';
import type { RunState } from '../card/run-state';

export type VerifiedHumanId = string & { readonly __brand: 'VerifiedHumanId' };
export type VerifiedBotId = string & { readonly __brand: 'VerifiedBotId' };

export type ImIdentityReason =
  | 'missing-raw-sender'
  | 'missing-sender-id'
  | 'contradictory-sender-id'
  | 'contradictory-sender-type'
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
  | 'unknown-sender'
  | 'mention-required'
  | 'human-command'
  | 'bot-command'
  | 'bot-not-direct-mention'
  | 'contradictory-mention'
  | 'untrusted-bot'
  | 'trusted-peer'
  | 'ordinary-message';

export type ImPromptReason = 'ordinary-message-batch' | 'trusted-peer-message';

export type ImReplyReason =
  | 'run-completed'
  | 'run-failed'
  | 'run-interrupted'
  | 'run-timed-out';
export type ImSenderOwnershipReason =
  | ImIdentityReason
  | 'direct-message'
  | 'verified-bot-sender';

export type ImSenderOwnership =
  | Readonly<{ kind: 'mention'; openId: string }>
  | Readonly<{ kind: 'none'; reason: ImSenderOwnershipReason }>;

export type ImTrustedPeer = Readonly<{
  alias: string;
  openId: VerifiedBotId;
}>;

export interface PlanImMessageInput {
  message: NormalizedMessage;
  scope: ImConversationScope;
  authorized: boolean;
  duplicate: boolean;
  mentionRequired: boolean;
  recognizedCommand: boolean;
  currentBotOpenId?: string;
  trustedPeerBots?: ReadonlyArray<{ alias: string; openId: string }>;
}

export type ImMessagePlan =
  | ImDroppedMessagePlan
  | ImCommandPlan
  | ImOrdinaryMessagePlan
  | ImPeerMessagePlan;

export type ImDroppedMessagePlan = Readonly<{
  lane: 'drop';
  reason: Extract<
    ImRouteReason,
    | 'access-denied'
    | 'duplicate-message'
    | 'unknown-sender'
    | 'mention-required'
    | 'bot-command'
    | 'bot-not-direct-mention'
    | 'contradictory-mention'
    | 'untrusted-bot'
  >;
  allowAccessHint: boolean;
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

export type ImPeerMessagePlan = Readonly<{
  lane: 'peer';
  reason: 'trusted-peer';
  scope: ImConversationScope;
  source: ImSourceMessage;
  peer: ImTrustedPeer;
  trustedPeers: readonly ImTrustedPeer[];
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

export type ImPeerPromptMessage = Readonly<{
  messageId: string;
  senderAlias: string;
  content: string;
  resourceFileKeys: readonly string[];
  interactiveCard?: unknown;
}>;

export type ImPromptPolicy =
  | Readonly<{
      kind: 'ordinary';
      reason: Extract<ImPromptReason, 'ordinary-message-batch'>;
      messages: readonly [ImPromptMessage, ...ImPromptMessage[]];
      botIdentity?: Readonly<{ openId: string; name?: string }>;
    }>
  | Readonly<{
      kind: 'peer';
      reason: Extract<ImPromptReason, 'trusted-peer-message'>;
      message: ImPeerPromptMessage;
      trustedPeerAliases: readonly string[];
      zeroHop: true;
    }>;

export type ImReplyPolicy = Readonly<{
  invocationKind: 'ordinary' | 'peer';
  scope: ImConversationScope;
  target: ImReplyTarget;
  senderOwnership: ImSenderOwnership;
}>;

export type ImInvocation = ImOrdinaryInvocation | ImPeerInvocation;

export type ImOrdinaryInvocation = Readonly<{
  kind: 'ordinary';
  routeReason: 'ordinary-message';
  scope: ImConversationScope;
  sourceMessages: readonly [ImSourceMessage, ...ImSourceMessage[]];
  replyTarget: ImReplyTarget;
  promptPolicy: Extract<ImPromptPolicy, { kind: 'ordinary' }>;
  replyPolicy: ImReplyPolicy & Readonly<{ invocationKind: 'ordinary' }>;
}>;

export type ImPeerInvocation = Readonly<{
  kind: 'peer';
  routeReason: 'trusted-peer';
  scope: ImConversationScope;
  sourceMessages: readonly [ImSourceMessage];
  replyTarget: ImReplyTarget;
  peerAlias: string;
  trustedPeers: readonly ImTrustedPeer[];
  promptPolicy: Extract<ImPromptPolicy, { kind: 'peer' }>;
  replyPolicy: ImReplyPolicy & Readonly<{ invocationKind: 'peer' }>;
}>;

export type ImReplyPlan = ImReplyPolicy &
  Readonly<{
    reason: ImReplyReason;
    state: RunState;
  }>;

export function planImMessage(input: PlanImMessageInput): ImMessagePlan {
  const source = snapshotSource(input.message);
  const allowAccessHint = source.sender.kind === 'human';
  if (!input.authorized) {
    return Object.freeze({ lane: 'drop', reason: 'access-denied', allowAccessHint });
  }
  if (input.duplicate) {
    return Object.freeze({ lane: 'drop', reason: 'duplicate-message', allowAccessHint: false });
  }
  const scope = snapshotScope(input.scope);
  if (source.sender.kind === 'unknown') {
    if (isBotCandidate(input.message)) {
      return Object.freeze({ lane: 'drop', reason: 'unknown-sender', allowAccessHint: false });
    }
    if (input.mentionRequired) {
      return Object.freeze({ lane: 'drop', reason: 'mention-required', allowAccessHint: false });
    }
    return Object.freeze({
      lane: 'ordinary',
      reason: 'ordinary-message',
      scope,
      source,
    });
  }
  if (source.sender.kind === 'human') {
    if (input.recognizedCommand) {
      return Object.freeze({
        lane: 'command',
        reason: 'human-command',
        scope,
        source,
      });
    }
    if (input.mentionRequired) {
      return Object.freeze({ lane: 'drop', reason: 'mention-required', allowAccessHint: false });
    }
    return Object.freeze({
      lane: 'ordinary',
      reason: 'ordinary-message',
      scope,
      source,
    });
  }

  if (input.recognizedCommand) {
    return Object.freeze({ lane: 'drop', reason: 'bot-command', allowAccessHint: false });
  }
  const mention = directCurrentBotMention(input.message, input.currentBotOpenId);
  if (mention === 'contradictory') {
    return Object.freeze({
      lane: 'drop',
      reason: 'contradictory-mention',
      allowAccessHint: false,
    });
  }
  if (mention === 'not-direct') {
    return Object.freeze({
      lane: 'drop',
      reason: 'bot-not-direct-mention',
      allowAccessHint: false,
    });
  }

  const trustedPeers = snapshotTrustedPeers(input.trustedPeerBots ?? []);
  const peerSenderId = source.sender.id;
  const peer = trustedPeers.find((candidate) => candidate.openId === peerSenderId);
  if (!peer) {
    return Object.freeze({ lane: 'drop', reason: 'untrusted-bot', allowAccessHint: false });
  }
  return Object.freeze({
    lane: 'peer',
    reason: 'trusted-peer',
    scope,
    source,
    peer,
    trustedPeers,
  });
}

export function createImInvocation(
  plans: readonly [ImOrdinaryMessagePlan, ...ImOrdinaryMessagePlan[]],
  botIdentity?: Readonly<{ openId: string; name?: string }>,
): ImOrdinaryInvocation;
export function createImInvocation(
  plans: readonly [ImPeerMessagePlan],
  botIdentity?: Readonly<{ openId: string; name?: string }>,
): ImPeerInvocation;
export function createImInvocation(
  plans:
    | readonly [ImOrdinaryMessagePlan, ...ImOrdinaryMessagePlan[]]
    | readonly [ImPeerMessagePlan],
  botIdentity?: Readonly<{ openId: string; name?: string }>,
): ImInvocation {
  const first = plans[0];
  if (first.lane === 'peer') {
    const target = replyTarget(first.source.message);
    const replyPolicy = Object.freeze({
      invocationKind: 'peer',
      scope: first.scope,
      target,
      senderOwnership: Object.freeze({ kind: 'none', reason: 'verified-bot-sender' }),
    }) satisfies ImPeerInvocation['replyPolicy'];
    const sourceMessages: readonly [ImSourceMessage] = Object.freeze([first.source]);
    return Object.freeze({
      kind: 'peer',
      routeReason: 'trusted-peer',
      scope: first.scope,
      sourceMessages,
      replyTarget: target,
      peerAlias: first.peer.alias,
      trustedPeers: first.trustedPeers,
      promptPolicy: Object.freeze({
        kind: 'peer',
        reason: 'trusted-peer-message',
        message: toPeerPromptMessage(first.source, first.peer.alias),
        trustedPeerAliases: Object.freeze(first.trustedPeers.map(({ alias }) => alias)),
        zeroHop: true,
      }),
      replyPolicy,
    });
  }

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
  const target = replyTarget(last.message);
  const replyPolicy = Object.freeze({
    invocationKind: 'ordinary',
    scope: first.scope,
    target,
    senderOwnership: senderOwnership(first.scope, last.sender),
  }) satisfies ImOrdinaryInvocation['replyPolicy'];
  return Object.freeze({
    kind: 'ordinary',
    routeReason: 'ordinary-message',
    scope: first.scope,
    sourceMessages: Object.freeze(sourceMessages),
    replyTarget: target,
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
    replyPolicy,
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
    ...invocation.replyPolicy,
    reason,
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
  const rawKind = senderKind(senderType);
  const normalizedKind = senderKind(message.senderType);
  if (
    (normalizedKind !== undefined && normalizedKind !== rawKind) ||
    (message.senderIsBot === true && rawKind !== 'bot') ||
    (message.senderIsBot === false && senderType === 'bot')
  ) {
    return Object.freeze({ kind: 'unknown', reason: 'contradictory-sender-type' });
  }
  if (rawKind === 'human') {
    return Object.freeze({ kind: 'human', id: verifiedHumanId(rawId) });
  }
  if (rawKind === 'bot') {
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

function toPeerPromptMessage(source: ImSourceMessage, alias: string): ImPeerPromptMessage {
  const message = source.message;
  const interactiveCard = readInteractiveCard(message);
  return Object.freeze({
    messageId: message.messageId,
    senderAlias: alias,
    content: message.content,
    resourceFileKeys: Object.freeze(message.resources.map((resource) => resource.fileKey)),
    ...(interactiveCard === undefined ? {} : { interactiveCard }),
  });
}

function snapshotTrustedPeers(
  peers: ReadonlyArray<{ alias: string; openId: string }>,
): readonly ImTrustedPeer[] {
  return Object.freeze(
    peers.map(({ alias, openId }) =>
      Object.freeze({
        alias,
        openId: verifiedBotId(openId),
      }),
    ),
  );
}

function directCurrentBotMention(
  message: NormalizedMessage,
  currentBotOpenId: string | undefined,
): 'direct' | 'not-direct' | 'contradictory' {
  if (!currentBotOpenId) return 'not-direct';
  const raw = message.raw;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('message' in raw) ||
    typeof raw.message !== 'object' ||
    raw.message === null ||
    !('mentions' in raw.message) ||
    !Array.isArray(raw.message.mentions)
  ) {
    return 'not-direct';
  }

  let direct = false;
  for (const mention of raw.message.mentions) {
    if (
      !mention ||
      typeof mention !== 'object' ||
      !('id' in mention) ||
      typeof mention.id !== 'object' ||
      mention.id === null ||
      !('open_id' in mention.id) ||
      mention.id.open_id !== currentBotOpenId
    ) {
      continue;
    }
    if (!('mentioned_type' in mention) || mention.mentioned_type !== 'bot') {
      return 'contradictory';
    }
    direct = true;
  }
  if (!direct) return 'not-direct';

  const normalized = (message.mentions ?? []).find(
    (mention) => mention.openId === currentBotOpenId,
  );
  if (!normalized || normalized.isBot === false) return 'contradictory';
  return 'direct';
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

function senderOwnership(
  scope: ImConversationScope,
  sender: ImSenderIdentity,
): ImSenderOwnership {
  if (sender.kind === 'human') {
    return Object.freeze({ kind: 'mention', openId: sender.id });
  }
  if (scope.mode === 'p2p') return Object.freeze({ kind: 'none', reason: 'direct-message' });
  return Object.freeze({
    kind: 'none',
    reason: sender.kind === 'bot' ? 'verified-bot-sender' : sender.reason,
  });
}

function senderKind(value: unknown): 'human' | 'bot' | undefined {
  if (value === 'user') return 'human';
  if (value === 'app' || value === 'bot') return 'bot';
  return undefined;
}

function isBotCandidate(message: NormalizedMessage): boolean {
  if (message.senderIsBot === true || senderKind(message.senderType) === 'bot') return true;
  const raw = message.raw;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('sender' in raw) ||
    typeof raw.sender !== 'object' ||
    raw.sender === null ||
    !('sender_type' in raw.sender)
  ) {
    return false;
  }
  return senderKind(raw.sender.sender_type) === 'bot';
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

