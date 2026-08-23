import { randomUUID } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { renderOmpReplyCard, renderOmpReplyMarkdown } from '../card/omp-reply-renderer';
import type { RunState } from '../card/run-state';

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

type DeliveryState = 'no_message' | 'unknown' | 'not_sent' | 'message_known' | 'delivered';
type OperationResult = 'success' | 'unknown' | 'rejected';
type ReplyTransport = 'managed' | 'inline' | 'markdown';
type ReplyRequest = Parameters<LarkChannel['rawClient']['im']['v1']['message']['reply']>[0];
type UpdateRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['update']>[0];
type CloseRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['settings']>[0];
type PatchRequest = Parameters<LarkChannel['updateCard']>;

interface Projection {
  card: object;
  serialized: string;
}

type PendingOperation =
  | {
      kind: 'reply';
      transport: ReplyTransport;
      terminal: boolean;
      uuid: string;
      sequence: 0;
      request: ReplyRequest;
      attempts: number;
      exhausted: boolean;
    }
  | {
      kind: 'update';
      uuid: string;
      sequence: number;
      projection: Projection;
      request: UpdateRequest;
      attempts: number;
      exhausted: boolean;
    }
  | {
      kind: 'close';
      uuid: string;
      sequence: number;
      request: CloseRequest;
      attempts: number;
      exhausted: boolean;
    }
  | {
      kind: 'patch';
      terminal: boolean;
      projection: Projection;
      request: PatchRequest;
      attempts: number;
      exhausted: boolean;
    };

const PROJECTION_THROTTLE_MS = 400;
const RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const CARD_ALREADY_BOUND = 200780;

/** Owns the one CardKit bubble used by an OMP instant-message Run. */
export class OmpReplyController {
  readonly #channel: LarkChannel;
  readonly #target: OmpReplyTarget;
  #opened = false;
  #transport: ReplyTransport | undefined;
  #cardId: string | undefined;
  #messageId: string | undefined;
  #deliveryState: DeliveryState = 'no_message';
  #messageKnown = false;
  #sequence = 0;
  #pending: PendingOperation | undefined;
  #writer: Promise<void> = Promise.resolve();
  #latestProjection: Projection | undefined;
  #lastSuccessfulProjection: string | undefined;
  #projectionTimer: NodeJS.Timeout | undefined;
  #terminalRequested = false;
  #finished = false;

  constructor(input: { channel: LarkChannel; target: OmpReplyTarget }) {
    this.#channel = input.channel;
    this.#target = input.target;
  }

  async open(initialState: RunState): Promise<void> {
    if (this.#opened) throw new Error('OMP Reply is already open');
    this.#opened = true;

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
    });
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
        if (markdown === 'rejected') throw this.deliveryFailure('terminal Markdown rejected');
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
          summary: { content: summaryFor(finalState) },
        }),
        sequence,
        uuid,
      },
    } satisfies CloseRequest;
    this.#pending = {
      kind: 'close',
      uuid,
      sequence,
      request,
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async patchKnownTerminal(projection: Projection): Promise<void> {
    if (!this.#messageId) throw this.deliveryFailure('known message has no message_id');
    const patch = await this.commitStaticPatch(projection, true);
    if (patch === 'rejected') throw this.deliveryFailure('static terminal patch rejected');
  }

  private async commitStaticPatch(
    projection: Projection,
    terminal: boolean,
  ): Promise<Exclude<OperationResult, 'unknown'>> {
    if (projection.serialized === this.#lastSuccessfulProjection) {
      if (terminal) this.#deliveryState = 'delivered';
      return 'success';
    }
    const messageId = this.#messageId;
    if (!messageId) throw this.deliveryFailure('same-message patch requires message_id');
    this.#pending = {
      kind: 'patch',
      terminal,
      projection,
      request: [messageId, projection.card],
      attempts: 0,
      exhausted: false,
    };
    return this.commitPending();
  }

  private async commitPending(): Promise<Exclude<OperationResult, 'unknown'>> {
    const operation = this.#pending;
    if (!operation) throw new Error('OMP Reply has no reserved operation');
    if (operation.exhausted) throw this.pendingError();

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
        return 'success';
      }
      if (result === 'rejected') {
        if (operation.kind === 'update' || operation.kind === 'close') {
          this.#sequence = operation.sequence;
        }
        this.#deliveryState = this.#messageKnown ? 'message_known' : 'not_sent';
        this.#pending = undefined;
        return 'rejected';
      }
      this.#deliveryState = 'unknown';
    }

    operation.exhausted = true;
    throw this.pendingError();
  }

  private completeOperation(operation: PendingOperation): void {
    if (operation.kind === 'reply') {
      this.#messageKnown = true;
      this.#deliveryState = operation.terminal ? 'delivered' : 'message_known';
      return;
    }
    if (operation.kind === 'patch') {
      this.#lastSuccessfulProjection = operation.projection.serialized;
      this.#deliveryState = operation.terminal ? 'delivered' : 'message_known';
      return;
    }

    this.#sequence = operation.sequence;
    if (operation.kind === 'update') {
      this.#lastSuccessfulProjection = operation.projection.serialized;
      this.#deliveryState = 'message_known';
    } else {
      this.#deliveryState = 'delivered';
    }
  }

  private async attempt(operation: PendingOperation): Promise<OperationResult> {
    try {
      if (operation.kind === 'reply') {
        const result = await this.#channel.rawClient.im.v1.message.reply(operation.request);
        const code = result.code;
        const messageId = result.data?.message_id;
        if (
          (code === undefined || code === 0) &&
          typeof messageId === 'string' &&
          messageId.trim()
        ) {
          this.#messageId = messageId;
          return 'success';
        }
        if (code === CARD_ALREADY_BOUND) {
          return operation.attempts > 1 ? 'success' : 'unknown';
        }
        return typeof code === 'number' && code !== 0 ? 'rejected' : 'unknown';
      }

      if (operation.kind === 'patch') {
        await this.#channel.updateCard(...operation.request);
        return 'success';
      }

      const result =
        operation.kind === 'update'
          ? await this.#channel.rawClient.cardkit.v1.card.update(operation.request)
          : await this.#channel.rawClient.cardkit.v1.card.settings(operation.request);
      const code = result.code;
      if (code === 0) return 'success';
      return typeof code === 'number' ? 'rejected' : 'unknown';
    } catch (error) {
      return isClearRejection(error) ? 'rejected' : 'unknown';
    }
  }

  private pendingError(): Error {
    const operation = this.#pending;
    const kind = operation?.kind ?? 'unknown';
    return new Error(`OMP Reply ${kind} delivery is ${this.#deliveryState}`);
  }

  private deliveryFailure(reason: string): Error {
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

function renderManagedCard(state: RunState): object {
  return {
    ...renderOmpReplyCard(state),
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: true,
      summary: { content: summaryFor(state) },
    },
  };
}

function summaryFor(state: RunState): string {
  if (state.terminal === 'done') return '已完成';
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

