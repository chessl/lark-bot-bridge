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
  | 'personal-substitution'
  | 'ordinary-message';

export type ImPromptReason =
  | 'ordinary-message-batch'
  | 'trusted-peer-message'
  | 'personal-substitution-message';

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

export type ImSubstitutionTarget = Readonly<{
  openId: VerifiedHumanId;
  displayAlias: string;
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
  personalSubstitution?: Readonly<{
    enabled: boolean;
    targetOpenIds: readonly string[];
  }>;
}

export type ImMessagePlan =
  | ImDroppedMessagePlan
  | ImCommandPlan
  | ImOrdinaryMessagePlan
  | ImPeerMessagePlan
  | ImSubstitutionMessagePlan;

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
  trustedPeers: readonly ImTrustedPeer[];
}>;

export type ImPeerMessagePlan = Readonly<{
  lane: 'peer';
  reason: 'trusted-peer';
  scope: ImConversationScope;
  source: ImSourceMessage;
  peer: ImTrustedPeer;
  trustedPeers: readonly ImTrustedPeer[];
}>;

export type ImSubstitutionMessagePlan = Readonly<{
  lane: 'substitution';
  reason: 'personal-substitution';
  scope: ImConversationScope;
  source: ImSourceMessage;
  targets: readonly [ImSubstitutionTarget];
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

export type ImSubstitutionPromptMessage = Readonly<{
  messageId: string;
  content: string;
  resourceFileKeys: readonly string[];
}>;

export type ImPromptPolicy =
  | Readonly<{
      kind: 'ordinary';
      reason: Extract<ImPromptReason, 'ordinary-message-batch'>;
      messages: readonly [ImPromptMessage, ...ImPromptMessage[]];
      botIdentity?: Readonly<{ openId: string; name?: string }>;
      trustedPeerAliases: readonly string[];
      oneHop: true;
    }>
  | Readonly<{
      kind: 'peer';
      reason: Extract<ImPromptReason, 'trusted-peer-message'>;
      message: ImPeerPromptMessage;
      trustedPeerAliases: readonly string[];
      zeroHop: true;
    }>
  | Readonly<{
      kind: 'substitution';
      reason: Extract<ImPromptReason, 'personal-substitution-message'>;
      message: ImSubstitutionPromptMessage;
      targetAliases: readonly [string];
    }>;

type ImReplyPolicyBase = Readonly<{
  scope: ImConversationScope;
  target: ImReplyTarget;
  senderOwnership: ImSenderOwnership;
}>;

export type ImPeerActivation = Readonly<{
  alias: string;
  openId: VerifiedBotId;
  start: number;
  end: number;
}>;

export type ImReplyPolicy =
  | (ImReplyPolicyBase & Readonly<{ invocationKind: 'ordinary' }>)
  | (ImReplyPolicyBase & Readonly<{ invocationKind: 'peer' }>)
  | (ImReplyPolicyBase &
      Readonly<{
        invocationKind: 'substitution';
        substitutionTargetOpenIds: readonly [string];
      }>);

export type ImInvocation = ImOrdinaryInvocation | ImPeerInvocation | ImSubstitutionInvocation;

export type ImOrdinaryInvocation = Readonly<{
  kind: 'ordinary';
  routeReason: 'ordinary-message';
  scope: ImConversationScope;
  sourceMessages: readonly [ImSourceMessage, ...ImSourceMessage[]];
  replyTarget: ImReplyTarget;
  promptPolicy: Extract<ImPromptPolicy, { kind: 'ordinary' }>;
  replyPolicy: Extract<ImReplyPolicy, { invocationKind: 'ordinary' }>;
  trustedPeers: readonly ImTrustedPeer[];
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
  replyPolicy: Extract<ImReplyPolicy, { invocationKind: 'peer' }>;
}>;

export type ImSubstitutionInvocation = Readonly<{
  kind: 'substitution';
  routeReason: 'personal-substitution';
  scope: ImConversationScope;
  sourceMessages: readonly [ImSourceMessage];
  replyTarget: ImReplyTarget;
  targets: readonly [ImSubstitutionTarget];
  promptPolicy: Extract<ImPromptPolicy, { kind: 'substitution' }>;
  replyPolicy: Extract<ImReplyPolicy, { invocationKind: 'substitution' }>;
}>;

export type ImReplyPlan = ImReplyPolicy &
  Readonly<{
    reason: ImReplyReason;
    state: RunState;
    peerActivation?: ImPeerActivation;
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
  const trustedPeers = snapshotTrustedPeers(input.trustedPeerBots ?? []);
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
      trustedPeers,
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
    const currentBotMention = directCurrentBotMention(input.message, input.currentBotOpenId);
    if (currentBotMention === 'contradictory') {
      return Object.freeze({
        lane: 'drop',
        reason: 'contradictory-mention',
        allowAccessHint: false,
      });
    }
    if (currentBotMention === 'direct') {
      return Object.freeze({
        lane: 'ordinary',
        reason: 'ordinary-message',
        scope,
        source,
        trustedPeers,
      });
    }
    const substitution = input.personalSubstitution;
    const configuredTarget =
      substitution?.enabled === true && substitution.targetOpenIds.length === 1
        ? substitution.targetOpenIds[0]
        : undefined;
    if (configuredTarget) {
      const targetMention = directSubstitutionMention(input.message, configuredTarget);
      if (targetMention === 'contradictory') {
        return Object.freeze({
          lane: 'drop',
          reason: 'contradictory-mention',
          allowAccessHint: false,
        });
      }
      if (targetMention !== 'not-direct') {
        const target: ImSubstitutionTarget = Object.freeze({
          openId: verifiedHumanId(configuredTarget),
          displayAlias: targetMention.displayAlias,
        });
        const targets: readonly [ImSubstitutionTarget] = Object.freeze([target]);
        return Object.freeze({
          lane: 'substitution',
          reason: 'personal-substitution',
          scope,
          source,
          targets,
        });
      }
    }
    if (input.mentionRequired) {
      return Object.freeze({ lane: 'drop', reason: 'mention-required', allowAccessHint: false });
    }
    return Object.freeze({
      lane: 'ordinary',
      reason: 'ordinary-message',
      scope,
      source,
      trustedPeers,
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
  plans: readonly [ImSubstitutionMessagePlan],
  botIdentity?: Readonly<{ openId: string; name?: string }>,
): ImSubstitutionInvocation;
export function createImInvocation(
  plans:
    | readonly [ImOrdinaryMessagePlan, ...ImOrdinaryMessagePlan[]]
    | readonly [ImPeerMessagePlan]
    | readonly [ImSubstitutionMessagePlan],
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
  if (first.lane === 'substitution') {
    const target = replyTarget(first.source.message);
    const sourceMessages: readonly [ImSourceMessage] = Object.freeze([first.source]);
    const targets: readonly [ImSubstitutionTarget] = Object.freeze([
      Object.freeze({ ...first.targets[0] }),
    ]);
    const substitutionTargetOpenIds: readonly [string] = Object.freeze([targets[0].openId]);
    const targetAliases: readonly [string] = Object.freeze([targets[0].displayAlias]);
    const replyPolicy = Object.freeze({
      invocationKind: 'substitution',
      scope: first.scope,
      target,
      senderOwnership: senderOwnership(first.scope, first.source.sender),
      substitutionTargetOpenIds,
    }) satisfies ImSubstitutionInvocation['replyPolicy'];
    return Object.freeze({
      kind: 'substitution',
      routeReason: 'personal-substitution',
      scope: first.scope,
      sourceMessages,
      replyTarget: target,
      targets,
      promptPolicy: Object.freeze({
        kind: 'substitution',
        reason: 'personal-substitution-message',
        message: toSubstitutionPromptMessage(first.source, targets[0].openId),
        targetAliases,
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
    trustedPeers: first.trustedPeers,
    promptPolicy: Object.freeze({
      kind: 'ordinary',
      reason: 'ordinary-message-batch',
      messages: Object.freeze(promptMessages),
      trustedPeerAliases: Object.freeze(first.trustedPeers.map(({ alias }) => alias)),
      oneHop: true,
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
  const answer =
    invocation.kind === 'ordinary' &&
    invocation.replyPolicy.senderOwnership.kind === 'mention' &&
    state.terminal === 'done'
      ? sanitizeImAnswer(state.finalText?.trim() ?? '')
      : '';
  const peerActivation =
    invocation.kind === 'ordinary' && answer.length > 0
      ? firstTrustedPeerActivation(answer, invocation.trustedPeers)
      : undefined;
  const finalState = peerActivation ? Object.freeze({ ...state, finalText: answer }) : state;
  return Object.freeze({
    ...invocation.replyPolicy,
    reason,
    state: finalState,
    ...(peerActivation ? { peerActivation } : {}),
  });
}

export function sanitizeImAnswer(answer: string): string {
  return answer
    .replace(
      /<at\b[^>]*>(.*?)<\/at>/gis,
      (_match, label: string) => `\\@${label.replaceAll('@', '\\@')}`,
    )
    .replace(/<\/?at\b[^>]*>/gi, '');
}

const LEGAL_ALIAS = /^[\p{L}\p{N}_-]+$/u;
const LEGAL_ALIAS_SOURCE = /^[\p{L}\p{N}\p{M}_-]+$/u;
const EMAIL_LOCAL = /^[\p{L}\p{N}._%+\-]$/u;
const RESERVED_ALIASES: Record<string, true> = { all: true, everyone: true, here: true };

function firstTrustedPeerActivation(
  answer: string,
  trustedPeers: readonly ImTrustedPeer[],
): ImPeerActivation | undefined {
  const peersByAlias = new Map<string, ImTrustedPeer>();
  for (const peer of trustedPeers) {
    const alias = normalizeAlias(peer.alias);
    if (LEGAL_ALIAS.test(alias) && !RESERVED_ALIASES[alias] && !peersByAlias.has(alias)) {
      peersByAlias.set(alias, peer);
    }
  }
  if (peersByAlias.size === 0) return undefined;

  const excluded = markdownCodeRanges(answer);
  let excludedIndex = 0;
  for (let start = 0; start < answer.length; ) {
    const range = excluded[excludedIndex];
    if (range && start >= range[1]) {
      excludedIndex++;
      continue;
    }
    if (range && start >= range[0]) {
      start = range[1];
      continue;
    }

    const marker = codePointAt(answer, start);
    if (marker.value.normalize('NFKC') !== '@') {
      start = marker.end;
      continue;
    }
    if (isEscapedAt(answer, start) || isEmailLikeAt(answer, start)) {
      start = marker.end;
      continue;
    }

    let end = marker.end;
    while (end < answer.length) {
      const tokenPart = codePointAt(answer, end);
      if (!LEGAL_ALIAS_SOURCE.test(tokenPart.value.normalize('NFKC'))) break;
      end = tokenPart.end;
    }
    const alias = normalizeAlias(answer.slice(marker.end, end));
    const peer = LEGAL_ALIAS.test(alias) ? peersByAlias.get(alias) : undefined;
    if (peer) {
      return Object.freeze({ alias: peer.alias, openId: peer.openId, start, end });
    }
    start = end > marker.end ? end : marker.end;
  }
  return undefined;
}

function normalizeAlias(alias: string): string {
  return alias.normalize('NFKC').toLowerCase();
}

function markdownCodeRanges(markdown: string): Array<readonly [number, number]> {
  const fenced: Array<readonly [number, number]> = [];
  let open: { start: number; marker: '`' | '~'; length: number } | undefined;
  for (let lineStart = 0; lineStart < markdown.length; ) {
    const newline = markdown.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const nextLine = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      const marker = match?.[1];
      if (marker) {
        open = {
          start: lineStart,
          marker: marker[0] === '`' ? '`' : '~',
          length: marker.length,
        };
      }
    } else {
      const close = new RegExp(`^ {0,3}\\${open.marker}{${open.length},}[ \\t]*$`);
      if (close.test(line)) {
        fenced.push([open.start, nextLine]);
        open = undefined;
      }
    }
    lineStart = nextLine;
  }
  if (open) fenced.push([open.start, markdown.length]);

  const ranges = [...fenced];
  for (let start = 0; start < markdown.length; ) {
    const fence = rangeContaining(fenced, start);
    if (fence) {
      start = fence[1];
      continue;
    }
    if (markdown[start] !== '`' || isEscapedAt(markdown, start)) {
      start = codePointAt(markdown, start).end;
      continue;
    }
    const length = delimiterLength(markdown, start, '`');
    let close = start + length;
    while (close < markdown.length) {
      const closeFence = rangeContaining(fenced, close);
      if (closeFence) {
        close = closeFence[1];
        continue;
      }
      if (
        markdown[close] === '`' &&
        !isEscapedAt(markdown, close) &&
        delimiterLength(markdown, close, '`') === length
      ) {
        ranges.push([start, close + length]);
        start = close + length;
        close = -1;
        break;
      }
      close = codePointAt(markdown, close).end;
    }
    if (close !== -1) start += length;
  }
  return ranges.sort((left, right) => left[0] - right[0]);
}

function rangeContaining(
  ranges: readonly (readonly [number, number])[],
  index: number,
): readonly [number, number] | undefined {
  let lower = 0;
  let upper = ranges.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const range = ranges[middle];
    if (!range) return undefined;
    if (index < range[0]) {
      upper = middle - 1;
    } else if (index >= range[1]) {
      lower = middle + 1;
    } else {
      return range;
    }
  }
  return undefined;
}

function delimiterLength(value: string, start: number, delimiter: string): number {
  let end = start;
  while (value[end] === delimiter) end++;
  return end - start;
}

function isEscapedAt(value: string, start: number): boolean {
  let slashes = 0;
  let end = start;
  while (end > 0) {
    const previous = previousCodePoint(value, end);
    if (previous.value.normalize('NFKC') !== '\\') break;
    slashes++;
    end = previous.start;
  }
  return slashes % 2 === 1;
}

function isEmailLikeAt(value: string, start: number): boolean {
  if (start === 0) return false;
  return EMAIL_LOCAL.test(previousCodePoint(value, start).value.normalize('NFKC'));
}

function codePointAt(value: string, start: number): { value: string; end: number } {
  const point = value.codePointAt(start);
  if (point === undefined) return { value: '', end: start };
  const character = String.fromCodePoint(point);
  return { value: character, end: start + character.length };
}

function previousCodePoint(
  value: string,
  end: number,
): { value: string; start: number } {
  let start = end - 1;
  const trailing = value.charCodeAt(start);
  if (start > 0 && trailing >= 0xdc00 && trailing <= 0xdfff) start--;
  return { value: value.slice(start, end), start };
}

export function substitutionMentionOpenIds(plan: ImReplyPlan): readonly string[] {
  return plan.invocationKind === 'substitution' &&
    plan.state.terminal === 'done' &&
    Boolean(plan.state.finalText?.trim())
    ? plan.substitutionTargetOpenIds
    : [];
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

function toSubstitutionPromptMessage(
  source: ImSourceMessage,
  targetOpenId: string,
): ImSubstitutionPromptMessage {
  const message = source.message;
  return Object.freeze({
    messageId: message.messageId,
    content: message.content.replaceAll(targetOpenId, '[目标]'),
    resourceFileKeys: Object.freeze(message.resources.map((resource) => resource.fileKey)),
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

function directSubstitutionMention(
  message: NormalizedMessage,
  targetOpenId: string,
): Readonly<{ displayAlias: string }> | 'not-direct' | 'contradictory' {
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
  const rawMatch = raw.message.mentions.some(
    (mention) =>
      Boolean(mention) &&
      typeof mention === 'object' &&
      'id' in mention &&
      typeof mention.id === 'object' &&
      mention.id !== null &&
      'open_id' in mention.id &&
      mention.id.open_id === targetOpenId,
  );
  if (!rawMatch) return 'not-direct';

  const normalized = (message.mentions ?? []).filter(
    (mention) => mention.openId === targetOpenId,
  );
  if (normalized.length === 0 || normalized.some((mention) => mention.isBot === true)) {
    return 'contradictory';
  }
  return Object.freeze({
    displayAlias: safeDisplayAlias(normalized[0]?.name, targetOpenId),
  });
}

function safeDisplayAlias(value: string | undefined, targetOpenId: string): string {
  const sanitized = (value ?? '')
    .normalize('NFKC')
    .replaceAll(targetOpenId, '')
    .replace(/<\/?at\b[^>]*>/gi, '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll('@', '＠')
    .trim();
  return [...sanitized].slice(0, 64).join('') || '目标';
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

