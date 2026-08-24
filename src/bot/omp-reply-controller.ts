import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import {
  ompReplyPresentation,
  renderOmpReplyCard,
  renderOmpReplyMarkdownPost,
  type ReplyMentionMode,
} from '../card/omp-reply-renderer';
import {
  initialState as emptyRunState,
  markInterrupted,
  type RunState,
  type Terminal,
} from '../card/run-state';
import { log } from '../core/logger';
import type {
  ImReplyPlan,
  ImReplyPolicy,
  ImReplyReason,
  ImReplyTarget,
  ImSenderOwnershipReason,
} from './im-invocation';
import type {
  ActiveDelivery,
  DeliveryFailureReason,
  DeliveryState,
  DurablePendingOperation,
  DurableMentionFallback,
  OmpDeliveryJournal,
  ReplyTransport,
} from './omp-delivery-journal';

type OperationResult = 'success' | 'unknown' | 'rejected' | 'mention_rejected';
type ReplyRequest = Parameters<LarkChannel['rawClient']['im']['v1']['message']['reply']>[0];
type UpdateRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['update']>[0];
type CloseRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['settings']>[0];
type PatchRequest = Parameters<LarkChannel['rawClient']['im']['v1']['message']['patch']>[0];

interface Projection {
  card: object;
  serialized: string;
}

type PendingOperation =
  | (Extract<DurablePendingOperation, { kind: 'reply' }> & PendingAttempt)
  | (Extract<DurablePendingOperation, { kind: 'update' }> &
      PendingAttempt & {
        projection: Projection;
      })
  | (Extract<DurablePendingOperation, { kind: 'close' }> & PendingAttempt)
  | (Extract<DurablePendingOperation, { kind: 'patch' }> &
      PendingAttempt & {
        projection: Projection;
      });

interface PendingAttempt {
  attempts: number;
  exhausted: boolean;
}

const PROJECTION_THROTTLE_MS = 400;
const RETRY_DELAYS_MS = [0, 500, 1_000] as const;

const TERMINAL_BY_IM_REPLY_REASON: Record<
  ImReplyReason,
  Exclude<Terminal, 'running'>
> = {
  'run-completed': 'done',
  'run-failed': 'error',
  'run-interrupted': 'interrupted',
  'run-timed-out': 'idle_timeout',
};
const CARD_ALREADY_BOUND = 200780;

/** Owns the one CardKit bubble used by an OMP instant-message Run. */
export class OmpReplyController {
  readonly #channel: LarkChannel;
  readonly #replyPolicy: ImReplyPolicy;
  readonly #journal: OmpDeliveryJournal | undefined;
  readonly #runId: string | undefined;
  readonly #now: () => number;
  readonly #openedAtMs: number;
  #opened = false;
  #transport: ReplyTransport | undefined;
  #cardId: string | undefined;
  #messageId: string | undefined;
  #deliveryState: DeliveryState = 'no_message';
  #messageKnown = false;
  #messageKnownAtMs: number | undefined;
  #sequence = 0;
  #pending: PendingOperation | undefined;
  #writer: Promise<void> = Promise.resolve();
  #latestProjection: Projection | undefined;
  #lastSuccessfulProjection: string | undefined;
  #projectionTimer: NodeJS.Timeout | undefined;
  #terminalRequested = false;
  #finished = false;

  constructor(input: {
    channel: LarkChannel;
    replyPolicy: ImReplyPolicy;
    journal?: OmpDeliveryJournal;
    runId?: string;
    now?: () => number;
  }) {
    if (Boolean(input.journal) !== Boolean(input.runId)) {
      throw new Error('OMP Reply journal and runId must be provided together');
    }
    this.#channel = input.channel;
    this.#replyPolicy = input.replyPolicy;
    this.#journal = input.journal;
    this.#runId = input.runId;
    this.#now = input.now ?? Date.now;
    this.#openedAtMs = this.#now();
  }

  async open(initialState: RunState): Promise<void> {
    if (this.#opened) throw new Error('OMP Reply is already open');
    this.#opened = true;
    if (this.#journal && this.#runId) {
      this.#journal.claim(this.#runId);
      await this.persist();
    }

    await this.enqueue(async () => {
      const inlineCard = renderOmpReplyCard(initialState);
      let cardId: string | undefined;
      try {
        cardId = (await this.#channel.createCard(renderManagedCard(initialState))).cardId;
      } catch {
        // An unbound CardKit entity cannot create a message, so abandoning it is safe.
      }
      if (cardId?.trim()) {
        this.#cardId = cardId;
        this.#transport = 'managed';
        await this.persist();
        const result = await this.commitReply(
          'managed',
          'interactive',
          JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          false,
          this.#replyPolicy.target,
        );
        if (result === 'success') return;
      }

      this.#transport = 'inline';
      const inline = await this.commitReply(
        'inline',
        'interactive',
        JSON.stringify(inlineCard),
        false,
        this.#replyPolicy.target,
      );
      if (inline === 'success') return;

      this.#transport = 'markdown';
      this.#deliveryState = 'not_sent';
      await this.persist();
    });
  }

  release(): void {
    if (this.#journal && this.#runId) this.#journal.release(this.#runId);
  }

  async project(state: RunState): Promise<void> {
    if (state.terminal !== 'running') {
      throw new Error('terminal OMP state must be finished, not projected');
    }
    const transport = this.requireOpen();
    if (this.#terminalRequested) throw new Error('OMP Reply is finishing');
    if (transport === 'markdown' || (transport === 'inline' && !this.#messageId)) return;

    this.#latestProjection = makeProjection(
      transport === 'managed' ? renderManagedCard(state) : renderOmpReplyCard(state),
    );
    if (!this.#projectionTimer) {
      this.#projectionTimer = setTimeout(() => {
        this.#projectionTimer = undefined;
        void this.enqueue(() => this.commitLatestProjection()).catch(() => undefined);
      }, PROJECTION_THROTTLE_MS);
    }
  }

  async finish(plan: ImReplyPlan): Promise<void> {
    validateFinalPlan(plan, this.#replyPolicy);
    const finalState = plan.state;
    if (finalState.terminal === 'running') throw new Error('cannot finish a running OMP Reply');
    if (this.#terminalRequested || this.#finished) throw new Error('OMP Reply is already finished');
    const transport = this.requireOpen();

    this.#terminalRequested = true;
    clearTimeout(this.#projectionTimer);
    this.#projectionTimer = undefined;
    this.#latestProjection = undefined;
    const staticTerminal = makeProjection(renderOmpReplyCard(plan));
    const degradedTerminal = hasReplyMention(plan)
      ? makeProjection(renderOmpReplyCard(plan, { streamingMode: false, mentionMode: 'plain' }))
      : undefined;
    logReplyMention('planned', plan, transport, mentionReason(plan));

    await this.enqueue(async () => {
      if (this.#pending) throw this.pendingError();

      if (transport === 'managed') {
        const update = await this.commitManagedProjection(
          makeProjection(renderManagedCard(plan)),
          true,
          degradedTerminal,
        );
        if (update === 'mention_rejected') {
          await this.patchKnownTerminal(degradedTerminal ?? staticTerminal, plan, true);
        } else if (update === 'rejected') {
          await this.patchKnownTerminal(staticTerminal, plan, false);
        } else {
          const close = await this.commitClose(finalState);
          if (close !== 'success') {
            await this.patchKnownTerminal(staticTerminal, plan, false);
          }
        }
      } else if (transport === 'inline') {
        await this.patchKnownTerminal(staticTerminal, plan, false, degradedTerminal);
      } else {
        const markdown = await this.commitReply(
          'markdown',
          'post',
          JSON.stringify(renderOmpReplyMarkdownPost(plan)),
          true,
          plan.target,
          degradedTerminal
            ? JSON.stringify(renderOmpReplyMarkdownPost(plan, 'plain'))
            : undefined,
        );
        if (markdown === 'mention_rejected' && hasReplyMention(plan)) {
          logReplyMention('degraded', plan, transport, 'mention-rejected');
          const degraded = await this.commitReply(
            'markdown',
            'post',
            JSON.stringify(renderOmpReplyMarkdownPost(plan, 'plain')),
            true,
            plan.target,
          );
          if (degraded !== 'success') throw this.deliveryFailure('terminal-markdown-rejected');
        } else if (markdown !== 'success') {
          throw this.deliveryFailure('terminal-markdown-rejected');
        }
      }
      logReplyMention('rendered', plan, transport, mentionReason(plan));
      this.#finished = true;
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#writer.then(work);
    this.#writer = result.catch(() => undefined);
    return result;
  }

  private async commitLatestProjection(): Promise<void> {
    if (this.#terminalRequested) return;
    const projection = this.#latestProjection;
    this.#latestProjection = undefined;
    if (!projection || projection.serialized === this.#lastSuccessfulProjection) return;
    if (this.#pending) throw this.pendingError();
    const transport = this.requireOpen();
    if (transport === 'managed') {
      await this.commitManagedProjection(projection);
    } else if (transport === 'inline' && this.#messageId) {
      await this.commitStaticPatch(projection, false);
    }
  }

  private async commitReply(
    transport: ReplyTransport,
    msgType: 'interactive' | 'post',
    content: string,
    terminal: boolean,
    target: ImReplyTarget,
    mentionFallbackContent?: string,
  ): Promise<Exclude<OperationResult, 'unknown'>> {
    const uuid = randomUUID();
    const request = {
      path: { message_id: target.messageId },
      data: {
        msg_type: msgType,
        content,
        reply_in_thread: target.replyInThread,
        uuid,
      },
    } satisfies ReplyRequest;
    this.#pending = {
      kind: 'reply',
      transport,
      terminal,
      uuid,
      sequence: 0,
      request,
      ...(mentionFallbackContent
        ? { mentionFallback: replyMentionFallback(target, mentionFallbackContent) }
        : {}),
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitManagedProjection(
    projection: Projection,
    terminal = false,
    mentionFallback?: Projection,
  ): Promise<Exclude<OperationResult, 'unknown'>> {
    if (projection.serialized === this.#lastSuccessfulProjection) return 'success';
    const cardId = this.requireManagedCard();
    const sequence = this.#sequence + 1;
    const uuid = randomUUID();
    const request = {
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: projection.serialized },
        sequence,
        uuid,
      },
    } satisfies UpdateRequest;
    this.#pending = {
      kind: 'update',
      terminal,
      uuid,
      sequence,
      projection,
      request,
      ...(mentionFallback && this.#messageId
        ? { mentionFallback: patchMentionFallback(this.#messageId, mentionFallback) }
        : {}),
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitClose(finalState: RunState): Promise<Exclude<OperationResult, 'unknown'>> {
    const cardId = this.requireManagedCard();
    const sequence = this.#sequence + 1;
    const uuid = randomUUID();
    const request = {
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({
          streaming_mode: false,
          summary: { content: ompReplyPresentation(finalState).summary },
        }),
        sequence,
        uuid,
      },
    } satisfies CloseRequest;
    this.#pending = {
      kind: 'close',
      terminal: true,
      uuid,
      sequence,
      request,
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async patchKnownTerminal(
    projection: Projection,
    plan: ImReplyPlan,
    degraded: boolean,
    fallback?: Projection,
  ): Promise<void> {
    if (!this.#messageId) throw this.deliveryFailure('known-message-missing-message-id');
    const patch = await this.commitStaticPatch(projection, true, fallback);
    if (patch === 'success') {
      if (degraded) logReplyMention('degraded', plan, this.requireOpen(), 'mention-rejected');
      return;
    }
    if (patch === 'mention_rejected' && fallback) {
      logReplyMention('degraded', plan, this.requireOpen(), 'mention-rejected');
      const retry = await this.commitStaticPatch(fallback, true);
      if (retry === 'success') return;
    }
    throw this.deliveryFailure('static-terminal-patch-rejected');
  }

  private async commitStaticPatch(
    projection: Projection,
    terminal: boolean,
    mentionFallback?: Projection,
  ): Promise<Exclude<OperationResult, 'unknown'>> {
    if (projection.serialized === this.#lastSuccessfulProjection) {
      if (terminal) {
        this.#deliveryState = 'delivered';
        await this.persist();
      }
      return 'success';
    }
    const messageId = this.#messageId;
    if (!messageId) throw this.deliveryFailure('same-message-patch-missing-message-id');
    this.#pending = {
      kind: 'patch',
      terminal,
      projection,
      uuid: randomUUID(),
      sequence: 0,
      request: {
        path: { message_id: messageId },
        data: { content: projection.serialized },
      } satisfies PatchRequest,
      ...(mentionFallback
        ? { mentionFallback: patchMentionFallback(messageId, mentionFallback) }
        : {}),
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitPending(): Promise<Exclude<OperationResult, 'unknown'>> {
    const operation = this.#pending;
    if (!operation) throw new Error('OMP Reply has no reserved operation');
    if (operation.exhausted) throw this.pendingError();
    this.#deliveryState = 'unknown';
    await this.persist();

    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, delayMs);
        await promise;
      }
      operation.attempts++;
      const result = await this.attempt(operation);
      if (result === 'success') {
        this.completeOperation(operation);
        this.#pending = undefined;
        await this.persist();
        return 'success';
      }
      if (result === 'rejected' || result === 'mention_rejected') {
        if (operation.kind === 'update' || operation.kind === 'close') {
          this.#sequence = operation.sequence;
        }
        const mentionFallback =
          operation.kind === 'close' ? undefined : operation.mentionFallback;
        if (result === 'mention_rejected' && mentionFallback) {
          this.#pending = pendingMentionFallback(mentionFallback);
        } else {
          this.#deliveryState = this.#messageKnown ? 'message_known' : 'not_sent';
          this.#pending = undefined;
        }
        await this.persist();
        return result;
      }
      this.#deliveryState = 'unknown';
      await this.persist();
    }

    operation.exhausted = true;
    throw this.pendingError();
  }

  private completeOperation(operation: PendingOperation): void {
    if (operation.kind === 'reply') {
      this.#messageKnown = true;
      this.#messageKnownAtMs ??= this.#now();
      this.#deliveryState = operation.terminal ? 'delivered' : 'message_known';
      return;
    }
    if (operation.kind === 'patch') {
      this.#lastSuccessfulProjection = operation.projection.serialized;
      this.#messageKnown = true;
      this.#messageKnownAtMs ??= this.#now();
      this.#deliveryState = operation.terminal ? 'delivered' : 'message_known';
      return;
    }

    this.#sequence = operation.sequence;
    if (operation.kind === 'update') {
      this.#lastSuccessfulProjection = operation.projection.serialized;
      this.#messageKnown = true;
      this.#messageKnownAtMs ??= this.#now();
      this.#deliveryState = 'message_known';
    } else {
      this.#deliveryState = 'delivered';
    }
  }

  private async persist(): Promise<void> {
    const journal = this.#journal;
    const runId = this.#runId;
    if (!journal || !runId) return;
    if (this.#deliveryState === 'delivered') {
      await journal.remove(runId);
      journal.release(runId);
      return;
    }
    const pending = this.#pending ? durableOperation(this.#pending) : undefined;
    const reservedSequence =
      pending && pending.sequence > 0 ? pending.sequence + 1 : this.#sequence + 1;
    const entry: ActiveDelivery = {
      runId,
      replyPolicy: this.#replyPolicy,
      ...(this.#cardId ? { cardId: this.#cardId } : {}),
      ...(this.#messageId ? { messageId: this.#messageId } : {}),
      ...(this.#transport ? { transport: this.#transport } : {}),
      deliveryState: this.#deliveryState,
      nextSequence: Math.max(this.#sequence + 1, reservedSequence),
      time: {
        openedAtMs: this.#openedAtMs,
        ...(this.#messageKnownAtMs === undefined
          ? {}
          : { messageKnownAtMs: this.#messageKnownAtMs }),
      },
      ...(pending ? { pending } : {}),
    };
    await journal.put(entry);
  }

  private async attempt(operation: PendingOperation): Promise<OperationResult> {
    const attempt = await attemptDurableOperation(
      this.#channel,
      durableOperation(operation),
      operation.kind === 'reply' && operation.attempts > 1,
    );
    if (attempt.messageId) this.#messageId = attempt.messageId;
    return attempt.result;
  }

  private pendingError(): Error {
    const operation = this.#pending;
    const kind = operation?.kind ?? 'unknown';
    return new Error(`OMP Reply ${kind} delivery is ${this.#deliveryState}`);
  }

  private deliveryFailure(reason: DeliveryFailureReason): Error {
    const error = new Error(`OMP Reply Delivery Failure: ${reason}`);
    error.name = 'OmpReplyDeliveryFailure';
    return error;
  }

  private requireOpen(): ReplyTransport {
    if (!this.#opened || !this.#transport) throw new Error('OMP Reply is not open');
    return this.#transport;
  }

  private requireManagedCard(): string {
    if (!this.#cardId) throw new Error('OMP Reply has no managed card');
    return this.#cardId;
  }
}

function replyMentionFallback(
  target: ImReplyTarget,
  content: string,
): DurableMentionFallback {
  const uuid = randomUUID();
  return {
    kind: 'reply',
    transport: 'markdown',
    terminal: true,
    uuid,
    sequence: 0,
    request: {
      path: { message_id: target.messageId },
      data: {
        msg_type: 'post',
        content,
        reply_in_thread: target.replyInThread,
        uuid,
      },
    },
  };
}

function patchMentionFallback(
  messageId: string,
  projection: Projection,
): DurableMentionFallback {
  return {
    kind: 'patch',
    terminal: true,
    uuid: randomUUID(),
    sequence: 0,
    request: {
      path: { message_id: messageId },
      data: { content: projection.serialized },
    },
  };
}

function pendingMentionFallback(fallback: DurableMentionFallback): PendingOperation {
  if (fallback.kind === 'reply') {
    return { ...fallback, attempts: 0, exhausted: false };
  }
  let card: object = {};
  try {
    const parsed: unknown = JSON.parse(fallback.request.data.content);
    if (typeof parsed === 'object' && parsed !== null) card = parsed;
  } catch {
    // The request remains authoritative; projection is only live completion bookkeeping.
  }
  return {
    ...fallback,
    projection: { card, serialized: fallback.request.data.content },
    attempts: 0,
    exhausted: false,
  };
}

function durableOperation(operation: PendingOperation): DurablePendingOperation {
  if (operation.kind === 'reply') {
    return {
      kind: 'reply',
      transport: operation.transport,
      terminal: operation.terminal,
      uuid: operation.uuid,
      sequence: 0,
      request: operation.request,
      ...(operation.mentionFallback ? { mentionFallback: operation.mentionFallback } : {}),
    };
  }
  if (operation.kind === 'update') {
    return {
      kind: 'update',
      terminal: operation.terminal,
      uuid: operation.uuid,
      sequence: operation.sequence,
      request: operation.request,
      ...(operation.mentionFallback ? { mentionFallback: operation.mentionFallback } : {}),
    };
  }
  if (operation.kind === 'close') {
    return {
      kind: 'close',
      terminal: true,
      uuid: operation.uuid,
      sequence: operation.sequence,
      request: operation.request,
    };
  }
  return {
    kind: 'patch',
    terminal: operation.terminal,
    uuid: operation.uuid,
    sequence: 0,
    request: operation.request,
    ...(operation.mentionFallback ? { mentionFallback: operation.mentionFallback } : {}),
  };
}

const INITIAL_UUID_WINDOW_MS = 60 * 60 * 1_000;
const MESSAGE_UPDATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export async function activateOmpReplyRecovery(input: {
  channel: LarkChannel;
  journal: OmpDeliveryJournal;
  now?: () => number;
  scanIntervalMs?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  await input.journal.load();
  let scanner = Promise.resolve();
  const scan = (startup: boolean): Promise<void> => {
    const result = scanner.then(() =>
      scanRecoverableDeliveries(input.channel, input.journal, now, startup),
    );
    scanner = result.catch(() => undefined);
    return result;
  };
  await scan(true);
  input.journal.startScanner(() => scan(false), input.scanIntervalMs);
}

async function scanRecoverableDeliveries(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  now: () => number,
  startup: boolean,
): Promise<void> {
  for (const entry of journal.entries()) {
    if (journal.isClaimed(entry.runId)) continue;
    const scanNow = now();
    if (
      entry.time.openedAtMs > scanNow ||
      (entry.time.messageKnownAtMs !== undefined && entry.time.messageKnownAtMs > scanNow)
    ) {
      await failRecovery(journal, entry, 'recovery-timestamp-in-future');
      continue;
    }
    if (entry.deliveryState === 'delivered') {
      if (startup) await journal.remove(entry.runId);
      continue;
    }
    if (entry.deliveryState === 'no_message' || entry.deliveryState === 'not_sent') {
      if (startup) await recoverInterrupted(channel, journal, entry, now);
      continue;
    }
    if (entry.deliveryState === 'message_known') {
      if (!startup) continue;
      if (isKnownEntryExpired(entry, scanNow)) {
        await failRecovery(journal, entry, 'message-update-window-expired');
        continue;
      }
      await recoverInterrupted(channel, journal, entry, now);
      continue;
    }
    if (!entry.pending) {
      await failRecovery(journal, entry, 'unknown-delivery-without-operation');
      continue;
    }
    const initialSubmission =
      entry.pending.kind === 'reply' && entry.time.messageKnownAtMs === undefined;
    if (
      initialSubmission
        ? scanNow - entry.time.openedAtMs > INITIAL_UUID_WINDOW_MS
        : isKnownEntryExpired(entry, scanNow)
    ) {
      await failRecovery(
        journal,
        entry,
        initialSubmission ? 'initial-uuid-window-expired' : 'message-update-window-expired',
      );
      continue;
    }
    await retryUnknownOperation(channel, journal, entry, now);
  }
}

async function retryUnknownOperation(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  now: () => number,
): Promise<void> {
  const pending = entry.pending;
  if (!pending) return;
  const mentionFallback = pending.kind === 'close' ? undefined : pending.mentionFallback;
  journal.claim(entry.runId);
  try {
    const attempt = await attemptDurableOperation(channel, pending, true);
    if (attempt.result === 'unknown') return;
    if (attempt.result === 'rejected' || attempt.result === 'mention_rejected') {
      if (attempt.result === 'mention_rejected' && mentionFallback) {
        const fallbackEntry =
          mentionFallback.kind === 'reply' && entry.time.messageKnownAtMs === undefined
            ? { ...entry, deliveryState: 'not_sent' as const, pending: undefined }
            : clearPending(entry, now, attempt.messageId);
        const plan = interruptedReplyPlan(entry.replyPolicy);
        logReplyMention(
          'degraded',
          plan,
          mentionFallback.kind === 'reply' ? 'markdown' : (entry.transport ?? 'inline'),
          'mention-rejected',
        );
        const fallbackResult = await submitRecoveryOperation(
          channel,
          journal,
          fallbackEntry,
          mentionFallback,
        );
        if (fallbackResult === 'unknown') return;
        if (fallbackResult === 'success') {
          logReplyRecovery('terminal-request-replayed', entry);
          await journal.remove(entry.runId);
          return;
        }
        await failRecovery(
          journal,
          fallbackEntry,
          mentionFallback.kind === 'reply'
            ? 'terminal-markdown-rejected'
            : 'static-terminal-patch-rejected',
        );
        return;
      }
      if (pending.kind === 'reply' && entry.time.messageKnownAtMs === undefined) {
        const plan = interruptedReplyPlan(entry.replyPolicy);
        logReplyMention('planned', plan, 'markdown', mentionReason(plan));
        const mentionMode =
          attempt.result === 'mention_rejected' && plan.senderOwnership.kind === 'mention'
            ? 'plain'
            : 'mention';
        if (mentionMode === 'plain') {
          logReplyMention('degraded', plan, 'markdown', 'mention-rejected');
        }
        await recoverInterruptedWithoutMessage(
          channel,
          journal,
          { ...entry, deliveryState: 'not_sent', pending: undefined },
          plan,
          mentionMode,
        );
        return;
      }
      if (
        attempt.result === 'mention_rejected' &&
        pending.terminal &&
        (pending.kind === 'update' || pending.kind === 'patch') &&
        entry.replyPolicy.senderOwnership.kind === 'mention'
      ) {
        const known = clearPending(entry, now, attempt.messageId);
        await journal.put(known);
        const plan = interruptedReplyPlan(entry.replyPolicy);
        logReplyMention('degraded', plan, entry.transport ?? 'inline', 'mention-rejected');
        await patchRecoveredMessage(
          channel,
          journal,
          known,
          plan,
          makeProjection(
            renderOmpReplyCard(plan, {
              streamingMode: false,
              toolCount: null,
              mentionMode: 'plain',
            }),
          ),
          'plain',
          false,
        );
        return;
      }
      const known = clearPending(entry, now, attempt.messageId);
      await journal.put(known);
      await recoverInterrupted(channel, journal, known, now);
      return;
    }

    const known = clearPending(entry, now, attempt.messageId);
    if (pending.terminal && pending.kind !== 'update') {
      logReplyRecovery('terminal-request-replayed', entry);
      await journal.remove(entry.runId);
      return;
    }
    await journal.put(known);
    if (pending.terminal) {
      await closeRecoveredManaged(
        channel,
        journal,
        known,
        now,
        interruptedReplyPlan(entry.replyPolicy),
      );
      return;
    }
    await recoverInterrupted(channel, journal, known, now);
  } finally {
    journal.release(entry.runId);
  }
}

function clearPending(
  entry: ActiveDelivery,
  now: () => number,
  messageId?: string,
): ActiveDelivery {
  return {
    ...entry,
    ...(messageId ? { messageId } : {}),
    deliveryState: 'message_known',
    nextSequence:
      entry.pending && entry.pending.sequence > 0
        ? Math.max(entry.nextSequence, entry.pending.sequence + 1)
        : entry.nextSequence,
    time: {
      ...entry.time,
      messageKnownAtMs: entry.time.messageKnownAtMs ?? now(),
    },
    pending: undefined,
  };
}

async function recoverInterrupted(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  now: () => number,
): Promise<void> {
  journal.claim(entry.runId);
  try {
    const plan = interruptedReplyPlan(entry.replyPolicy);
    logReplyMention('planned', plan, entry.transport ?? 'markdown', mentionReason(plan));
    const staticProjection = makeProjection(
      renderOmpReplyCard(plan, { streamingMode: false, toolCount: null }),
    );
    if (entry.transport === 'managed' && entry.cardId) {
      const sequence = entry.nextSequence;
      const uuid = randomUUID();
      const pending: DurablePendingOperation = {
        kind: 'update',
        terminal: true,
        uuid,
        sequence,
        request: {
          path: { card_id: entry.cardId },
          data: {
            card: {
              type: 'card_json',
              data: JSON.stringify(renderManagedCard(plan, null)),
            },
            sequence,
            uuid,
          },
        },
      };
      const update = await submitRecoveryOperation(channel, journal, entry, pending);
      if (update === 'unknown') return;
      const known = clearPending({ ...entry, nextSequence: sequence + 1, pending }, now);
      await journal.put(known);
      if (update === 'mention_rejected') {
        const degraded = plan.senderOwnership.kind === 'mention';
        if (degraded) {
          logReplyMention('degraded', plan, 'managed', 'mention-rejected');
        }
        await patchRecoveredMessage(
          channel,
          journal,
          known,
          plan,
          degraded
            ? makeProjection(
                renderOmpReplyCard(plan, {
                  streamingMode: false,
                  toolCount: null,
                  mentionMode: 'plain',
                }),
              )
            : staticProjection,
          degraded ? 'plain' : 'mention',
          false,
        );
        return;
      }
      if (update === 'rejected') {
        await patchRecoveredMessage(
          channel,
          journal,
          known,
          plan,
          staticProjection,
          'mention',
          false,
        );
        return;
      }
      await closeRecoveredManaged(channel, journal, known, now, plan);
      return;
    }
    if (!entry.messageId) {
      await recoverInterruptedWithoutMessage(channel, journal, entry, plan);
      return;
    }
    await patchRecoveredMessage(
      channel,
      journal,
      entry,
      plan,
      staticProjection,
      'mention',
      true,
    );
  } finally {
    journal.release(entry.runId);
  }
}

async function recoverInterruptedWithoutMessage(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  plan: ImReplyPlan,
  initialMode: ReplyMentionMode = 'mention',
): Promise<void> {
  let mode: ReplyMentionMode = initialMode;
  let pending = recoveryReplyOperation(plan, mode);
  let result = await submitRecoveryOperation(channel, journal, entry, pending);
  if (result === 'unknown') return;
  if (result === 'mention_rejected' && mode === 'mention' && plan.senderOwnership.kind === 'mention') {
    mode = 'plain';
    logReplyMention('degraded', plan, 'markdown', 'mention-rejected');
    pending = recoveryReplyOperation(plan, mode);
    result = await submitRecoveryOperation(channel, journal, entry, pending);
  }
  if (result !== 'success') {
    await failRecovery(journal, entry, 'terminal-markdown-rejected');
    return;
  }
  if (result === 'success') {
    logReplyMention('rendered', plan, 'markdown', mentionReason(plan));
    logReplyRecovery('interrupted-after-restart', entry);
    await journal.remove(entry.runId);
  }
}

function recoveryReplyOperation(
  plan: ImReplyPlan,
  mentionMode: ReplyMentionMode,
): DurablePendingOperation {
  const uuid = randomUUID();
  return {
    kind: 'reply',
    transport: 'markdown',
    terminal: true,
    uuid,
    sequence: 0,
    request: {
      path: { message_id: plan.target.messageId },
      data: {
        msg_type: 'post',
        content: JSON.stringify(renderOmpReplyMarkdownPost(plan, mentionMode)),
        reply_in_thread: plan.target.replyInThread,
        uuid,
      },
    },
  };
}

async function closeRecoveredManaged(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  now: () => number,
  plan: ImReplyPlan,
): Promise<void> {
  if (!entry.cardId) {
    await failRecovery(journal, entry, 'managed-recovery-missing-card-id');
    return;
  }
  const sequence = entry.nextSequence;
  const uuid = randomUUID();
  const pending: DurablePendingOperation = {
    kind: 'close',
    terminal: true,
    uuid,
    sequence,
    request: {
      path: { card_id: entry.cardId },
      data: {
        settings: JSON.stringify({
          streaming_mode: false,
          summary: { content: ompReplyPresentation(plan.state).summary },
        }),
        sequence,
        uuid,
      },
    },
  };
  const close = await submitRecoveryOperation(channel, journal, entry, pending);
  if (close === 'unknown') return;
  const known = clearPending({ ...entry, nextSequence: sequence + 1, pending }, now);
  await journal.put(known);
  if (close !== 'success') {
    await patchRecoveredMessage(
      channel,
      journal,
      known,
      plan,
      makeProjection(renderOmpReplyCard(plan, { streamingMode: false, toolCount: null })),
      'mention',
      false,
    );
    return;
  }
  logReplyMention('rendered', plan, 'managed', mentionReason(plan));
  logReplyRecovery('interrupted-after-restart', entry);
  await journal.remove(entry.runId);
}

async function patchRecoveredMessage(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  plan: ImReplyPlan,
  projection: Projection,
  mentionMode: ReplyMentionMode,
  allowDegrade: boolean,
): Promise<void> {
  if (!entry.messageId) {
    await failRecovery(journal, entry, 'same-message-recovery-missing-message-id');
    return;
  }
  const messageId = entry.messageId;
  const operation = (mode: ReplyMentionMode, card: Projection): DurablePendingOperation => ({
    kind: 'patch',
    terminal: true,
    uuid: randomUUID(),
    sequence: 0,
    request: {
      path: { message_id: messageId },
      data: {
        content:
          entry.transport === 'markdown'
            ? JSON.stringify(renderOmpReplyMarkdownPost(plan, mode))
            : card.serialized,
      },
    },
  });
  let patch = await submitRecoveryOperation(
    channel,
    journal,
    entry,
    operation(mentionMode, projection),
  );
  if (patch === 'unknown') return;
  if (patch === 'mention_rejected' && allowDegrade && plan.senderOwnership.kind === 'mention') {
    logReplyMention('degraded', plan, entry.transport ?? 'inline', 'mention-rejected');
    const degraded = makeProjection(
      renderOmpReplyCard(plan, {
        streamingMode: false,
        toolCount: null,
        mentionMode: 'plain',
      }),
    );
    patch = await submitRecoveryOperation(channel, journal, entry, operation('plain', degraded));
    if (patch === 'unknown') return;
  }
  if (patch !== 'success') {
    await failRecovery(journal, entry, 'static-terminal-patch-rejected');
    return;
  }
  logReplyMention('rendered', plan, entry.transport ?? 'inline', mentionReason(plan));
  logReplyRecovery('interrupted-after-restart', entry);
  await journal.remove(entry.runId);
}

async function submitRecoveryOperation(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  pending: DurablePendingOperation,
): Promise<OperationResult> {
  await journal.put({
    ...entry,
    deliveryState: 'unknown',
    nextSequence:
      pending.sequence > 0
        ? Math.max(entry.nextSequence, pending.sequence + 1)
        : entry.nextSequence,
    pending,
  });
  for (const delayMs of RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    const attempt = await attemptDurableOperation(channel, pending, true);
    if (attempt.result !== 'unknown') return attempt.result;
  }
  return 'unknown';
}

async function attemptDurableOperation(
  channel: LarkChannel,
  operation: DurablePendingOperation,
  exactRetry: boolean,
): Promise<{ result: OperationResult; messageId?: string }> {
  try {
    if (operation.kind === 'reply') {
      const response = await channel.rawClient.im.v1.message.reply(operation.request);
      const code = response.code;
      const messageId = response.data?.message_id;
      if ((code === undefined || code === 0) && typeof messageId === 'string' && messageId.trim()) {
        return { result: 'success', messageId };
      }
      if (code === CARD_ALREADY_BOUND) {
        return { result: exactRetry ? 'success' : 'unknown' };
      }
      return {
        result:
          typeof code === 'number' && code !== 0
            ? rejectedOperation(response)
            : 'unknown',
      };
    }
    if (operation.kind === 'patch') {
      const response = await channel.rawClient.im.v1.message.patch(operation.request);
      const code = response.code;
      return {
        result:
          code === 0
            ? 'success'
            : typeof code === 'number'
              ? rejectedOperation(response)
              : 'unknown',
      };
    }
    const response =
      operation.kind === 'update'
        ? await channel.rawClient.cardkit.v1.card.update(operation.request)
        : await channel.rawClient.cardkit.v1.card.settings(operation.request);
    const code = response.code;
    return {
      result:
        code === 0
          ? 'success'
          : typeof code === 'number'
            ? rejectedOperation(response)
            : 'unknown',
    };
  } catch (error) {
    return {
      result: isClearRejection(error) ? rejectedOperation(error) : 'unknown',
    };
  }
}

function rejectedOperation(value: unknown): Extract<OperationResult, 'rejected' | 'mention_rejected'> {
  if (value && typeof value === 'object') {
    const message =
      'msg' in value && typeof value.msg === 'string'
        ? value.msg
        : 'message' in value && typeof value.message === 'string'
          ? value.message
          : '';
    if (/(?:\bmention\b|@|提及)/iu.test(message)) return 'mention_rejected';
  }
  return 'rejected';
}

function isKnownEntryExpired(entry: ActiveDelivery, nowMs: number): boolean {
  const knownAt = entry.time.messageKnownAtMs;
  return knownAt === undefined || nowMs - knownAt > MESSAGE_UPDATE_WINDOW_MS;
}

async function failRecovery(
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  reason: DeliveryFailureReason,
): Promise<void> {
  journal.recordFailure(entry.runId, reason);
  await journal.remove(entry.runId);
}

function validateFinalPlan(plan: ImReplyPlan, progressPolicy: ImReplyPolicy): void {
  switch (plan.invocationKind) {
    case 'ordinary':
    case 'peer':
      break;
    default: {
      const exhaustive: never = plan.invocationKind;
      throw new Error(`unsupported IM Invocation kind: ${exhaustive}`);
    }
  }

  const expectedTerminal = TERMINAL_BY_IM_REPLY_REASON[plan.reason];
  if (plan.state.terminal !== expectedTerminal) {
    throw new Error(`IM Reply reason ${plan.reason} contradicts Run termination`);
  }

  const expectedScopeId =
    plan.scope.kind === 'topic'

      ? `${plan.scope.chatId}:${plan.scope.threadId}`
      : plan.scope.chatId;
  if (plan.scope.id !== expectedScopeId || plan.scope.chatId !== plan.target.chatId) {
    throw new Error('IM Reply target does not belong to its Conversation Scope');
  }
  if (
    (plan.scope.kind === 'topic' &&
      (!plan.target.replyInThread || plan.target.threadId !== plan.scope.threadId)) ||
    (plan.scope.kind === 'chat' && plan.target.replyInThread)
  ) {
    throw new Error('IM Reply placement contradicts its Conversation Scope');
  }
  if (
    JSON.stringify({
      invocationKind: plan.invocationKind,
      scope: plan.scope,
      target: plan.target,
      senderOwnership: plan.senderOwnership,
    }) !== JSON.stringify(progressPolicy)
  ) {
    throw new Error('Final IM Reply policy differs from the frozen Progress Reply policy');
  }
}

type ReplyMentionEvent = 'planned' | 'rendered' | 'degraded';
type ReplyMentionReason =
  | 'verified-human-sender'
  | 'trusted-peer-alias'
  | 'mention-rejected'
  | ImSenderOwnershipReason;
type ReplyRecoveryReason = 'interrupted-after-restart' | 'terminal-request-replayed';

function interruptedReplyPlan(replyPolicy: ImReplyPolicy): ImReplyPlan {
  return {
    ...replyPolicy,
    reason: 'run-interrupted',
    state: markInterrupted(emptyRunState),
  };
}

function mentionReason(plan: ImReplyPlan): ReplyMentionReason {
  if (plan.peerActivation) return 'trusted-peer-alias';
  return plan.senderOwnership.kind === 'mention'
    ? 'verified-human-sender'
    : plan.senderOwnership.reason;
}

function hasReplyMention(plan: ImReplyPlan): boolean {
  return plan.senderOwnership.kind === 'mention' || plan.peerActivation !== undefined;
}

function logReplyMention(
  event: ReplyMentionEvent,
  plan: ImReplyPlan,
  transport: ReplyTransport,
  reason: ReplyMentionReason,
): void {
  log.info('reply.mention', event, {
    reason,
    invocationKind: plan.invocationKind,
    transport,
    scope: plan.scope.kind,
  });
}

function logReplyRecovery(reason: ReplyRecoveryReason, entry: ActiveDelivery): void {
  log.info('reply-recovery', 'recovered', {
    reason,
    invocationKind: entry.replyPolicy.invocationKind,
    transport: entry.transport ?? 'markdown',
    scope: entry.replyPolicy.scope.kind,
  });
}

function makeProjection(card: object): Projection {
  return { card, serialized: JSON.stringify(card) };
}

function isClearRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'number') return code !== 0;
  const status = 'status' in error ? error.status : undefined;
  if (typeof status === 'number') return status >= 400 && status < 500 && status !== 429;
  if (!('response' in error) || !error.response || typeof error.response !== 'object') {
    return false;
  }
  const responseStatus = 'status' in error.response ? error.response.status : undefined;
  return (
    typeof responseStatus === 'number' &&
    responseStatus >= 400 &&
    responseStatus < 500 &&
    responseStatus !== 429
  );
}

function renderManagedCard(
  input: RunState | ImReplyPlan,
  toolCount?: number | null,
  mentionMode?: ReplyMentionMode,
): object {
  return renderOmpReplyCard(input, {
    streamingMode: true,
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(mentionMode === undefined ? {} : { mentionMode }),
  });
}
