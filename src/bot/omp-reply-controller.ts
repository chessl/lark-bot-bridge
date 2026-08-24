import { randomUUID } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import {
  ompReplyPresentation,
  renderOmpReplyCard,
  renderOmpReplyMarkdown,
} from '../card/omp-reply-renderer';
import { initialState as emptyRunState, markInterrupted, type RunState } from '../card/run-state';
import type {
  ActiveDelivery,
  DeliveryFailureReason,
  DeliveryState,
  DurablePendingOperation,
  OmpDeliveryJournal,
  ReplyTransport,
} from './omp-delivery-journal';

export type OmpReplyTarget =
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

export function deriveOmpReplyTarget(
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
): OmpReplyTarget {
  return Object.freeze(
    message.threadId
      ? {
          chatId: message.chatId,
          messageId: message.messageId,
          threadId: message.threadId,
          replyInThread: true,
        }
      : {
          chatId: message.chatId,
          messageId: message.messageId,
          replyInThread: false,
        },
  );
}

type OperationResult = 'success' | 'unknown' | 'rejected';
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
  | (Extract<DurablePendingOperation, { kind: 'update' }> & PendingAttempt & {
      projection: Projection;
    })
  | (Extract<DurablePendingOperation, { kind: 'close' }> & PendingAttempt)
  | (Extract<DurablePendingOperation, { kind: 'patch' }> & PendingAttempt & {
      projection: Projection;
    });

interface PendingAttempt {
  attempts: number;
  exhausted: boolean;
}

const PROJECTION_THROTTLE_MS = 400;
const RETRY_DELAYS_MS = [0, 500, 1_000] as const;
const CARD_ALREADY_BOUND = 200780;

/** Owns the one CardKit bubble used by an OMP instant-message Run. */
export class OmpReplyController {
  readonly #channel: LarkChannel;
  readonly #target: OmpReplyTarget;
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
    target: OmpReplyTarget;
    journal?: OmpDeliveryJournal;
    runId?: string;
    now?: () => number;
  }) {
    if (Boolean(input.journal) !== Boolean(input.runId)) {
      throw new Error('OMP Reply journal and runId must be provided together');
    }
    this.#channel = input.channel;
    this.#target = input.target;
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
        );
        if (result === 'success') return;
      }

      this.#transport = 'inline';
      const inline = await this.commitReply(
        'inline',
        'interactive',
        JSON.stringify(inlineCard),
        false,
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

  async finish(finalState: RunState): Promise<void> {
    if (finalState.terminal === 'running') throw new Error('cannot finish a running OMP Reply');
    if (this.#terminalRequested || this.#finished) throw new Error('OMP Reply is already finished');
    const transport = this.requireOpen();

    this.#terminalRequested = true;
    clearTimeout(this.#projectionTimer);
    this.#projectionTimer = undefined;
    this.#latestProjection = undefined;
    const staticTerminal = makeProjection(renderOmpReplyCard(finalState));

    await this.enqueue(async () => {
      if (this.#pending) throw this.pendingError();

      if (transport === 'managed') {
        const update = await this.commitManagedProjection(
          makeProjection(renderManagedCard(finalState)),
          true,
        );
        if (update === 'rejected') {
          await this.patchKnownTerminal(staticTerminal);
        } else {
          const close = await this.commitClose(finalState);
          if (close === 'rejected') await this.patchKnownTerminal(staticTerminal);
        }
      } else if (transport === 'inline') {
        await this.patchKnownTerminal(staticTerminal);
      } else {
        const markdown = await this.commitReply(
          'markdown',
          'post',
          JSON.stringify(markdownPost(renderOmpReplyMarkdown(finalState))),
          true,
        );
        if (markdown === 'rejected') throw this.deliveryFailure('terminal-markdown-rejected');
      }
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
  ): Promise<Exclude<OperationResult, 'unknown'>> {
    const uuid = randomUUID();
    const request = {
      path: { message_id: this.#target.messageId },
      data: {
        msg_type: msgType,
        content,
        reply_in_thread: this.#target.replyInThread,
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
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitManagedProjection(
    projection: Projection,
    terminal = false,
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
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitClose(
    finalState: RunState,
  ): Promise<Exclude<OperationResult, 'unknown'>> {
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

  private async patchKnownTerminal(projection: Projection): Promise<void> {
    if (!this.#messageId) throw this.deliveryFailure('known-message-missing-message-id');
    const patch = await this.commitStaticPatch(projection, true);
    if (patch === 'rejected') throw this.deliveryFailure('static-terminal-patch-rejected');
  }

  private async commitStaticPatch(
    projection: Projection,
    terminal: boolean,
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
      if (result === 'rejected') {
        if (operation.kind === 'update' || operation.kind === 'close') {
          this.#sequence = operation.sequence;
        }
        this.#deliveryState = this.#messageKnown ? 'message_known' : 'not_sent';
        this.#pending = undefined;
        await this.persist();
        return 'rejected';
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
      target: this.#target,
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

function durableOperation(operation: PendingOperation): DurablePendingOperation {
  if (operation.kind === 'reply') {
    return {
      kind: 'reply',
      transport: operation.transport,
      terminal: operation.terminal,
      uuid: operation.uuid,
      sequence: 0,
      request: operation.request,
    };
  }
  if (operation.kind === 'update') {
    return {
      kind: 'update',
      terminal: operation.terminal,
      uuid: operation.uuid,
      sequence: operation.sequence,
      request: operation.request,
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
    const result = scanner.then(() => scanRecoverableDeliveries(input.channel, input.journal, now, startup));
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
    if (
      entry.deliveryState === 'no_message' ||
      entry.deliveryState === 'delivered' ||
      entry.deliveryState === 'not_sent'
    ) {
      if (startup) await journal.remove(entry.runId);
      continue;
    }
    const scanNow = now();
    if (
      entry.time.openedAtMs > scanNow ||
      (entry.time.messageKnownAtMs !== undefined && entry.time.messageKnownAtMs > scanNow)
    ) {
      await failRecovery(journal, entry, 'recovery-timestamp-in-future');
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
  journal.claim(entry.runId);
  try {
    const attempt = await attemptDurableOperation(channel, pending, true);
    if (attempt.result === 'unknown') return;
    if (attempt.result === 'rejected') {
      if (pending.kind === 'reply' && entry.time.messageKnownAtMs === undefined) {
        await journal.remove(entry.runId);
        return;
      }
      if (pending.kind === 'patch') {
        await failRecovery(journal, entry, 'static-terminal-patch-rejected');
        return;
      }
      const known = clearPending(entry, now, attempt.messageId);
      await journal.put(known);
      await recoverInterrupted(channel, journal, known, now);
      return;
    }

    const known = clearPending(entry, now, attempt.messageId);
    await journal.put(known);
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
    const interrupted = markInterrupted(emptyRunState);
    const staticProjection = makeProjection(
      renderOmpReplyCard(interrupted, { streamingMode: false, toolCount: null }),
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
              data: JSON.stringify(renderManagedCard(interrupted, null)),
            },
            sequence,
            uuid,
          },
        },
      };
      const update = await submitRecoveryOperation(channel, journal, entry, pending);
      if (update === 'unknown') return;
      const known = clearPending(
        { ...entry, nextSequence: sequence + 1, pending },
        now,
      );
      await journal.put(known);
      if (update === 'rejected') {
        await patchRecoveredMessage(channel, journal, known, staticProjection);
        return;
      }
      await closeRecoveredManaged(channel, journal, known, now);
      return;
    }
    await patchRecoveredMessage(channel, journal, entry, staticProjection);
  } finally {
    journal.release(entry.runId);
  }
}

async function closeRecoveredManaged(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  now: () => number,
): Promise<void> {
  if (!entry.cardId) {
    await failRecovery(journal, entry, 'managed-recovery-missing-card-id');
    return;
  }
  const interrupted = markInterrupted(emptyRunState);
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
          summary: { content: ompReplyPresentation(interrupted).summary },
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
  if (close === 'rejected') {
    await patchRecoveredMessage(
      channel,
      journal,
      known,
      makeProjection(
        renderOmpReplyCard(interrupted, { streamingMode: false, toolCount: null }),
      ),
    );
    return;
  }
  await journal.remove(entry.runId);
}

async function patchRecoveredMessage(
  channel: LarkChannel,
  journal: OmpDeliveryJournal,
  entry: ActiveDelivery,
  projection: Projection,
): Promise<void> {
  if (!entry.messageId) {
    await failRecovery(journal, entry, 'same-message-recovery-missing-message-id');
    return;
  }
  const content =
    entry.transport === 'markdown'
      ? JSON.stringify(
          markdownPost(
            renderOmpReplyMarkdown(markInterrupted(emptyRunState), { toolCount: null }),
          ),
        )
      : projection.serialized;
  const pending: DurablePendingOperation = {
    kind: 'patch',
    terminal: true,
    uuid: randomUUID(),
    sequence: 0,
    request: {
      path: { message_id: entry.messageId },
      data: { content },
    },
  };
  const patch = await submitRecoveryOperation(channel, journal, entry, pending);
  if (patch === 'unknown') return;
  if (patch === 'rejected') {
    await failRecovery(journal, entry, 'static-terminal-patch-rejected');
    return;
  }
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
      pending.sequence > 0 ? Math.max(entry.nextSequence, pending.sequence + 1) : entry.nextSequence,
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
      if (
        (code === undefined || code === 0) &&
        typeof messageId === 'string' &&
        messageId.trim()
      ) {
        return { result: 'success', messageId };
      }
      if (code === CARD_ALREADY_BOUND && exactRetry) return { result: 'success' };
      return {
        result: typeof code === 'number' && code !== 0 ? 'rejected' : 'unknown',
      };
    }
    if (operation.kind === 'patch') {
      const response = await channel.rawClient.im.v1.message.patch(operation.request);
      const code = response.code;
      return { result: code === 0 ? 'success' : typeof code === 'number' ? 'rejected' : 'unknown' };
    }
    const response =
      operation.kind === 'update'
        ? await channel.rawClient.cardkit.v1.card.update(operation.request)
        : await channel.rawClient.cardkit.v1.card.settings(operation.request);
    const code = response.code;
    return { result: code === 0 ? 'success' : typeof code === 'number' ? 'rejected' : 'unknown' };
  } catch (error) {
    return { result: isClearRejection(error) ? 'rejected' : 'unknown' };
  }
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

function makeProjection(card: object): Projection {
  return { card, serialized: JSON.stringify(card) };
}

function markdownPost(markdown: string): object {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: markdown }]],
    },
  };
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

function renderManagedCard(state: RunState, toolCount?: number | null): object {
  return renderOmpReplyCard(state, {
    streamingMode: true,
    ...(toolCount === undefined ? {} : { toolCount }),
  });
}

