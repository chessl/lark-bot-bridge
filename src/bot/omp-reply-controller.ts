import { randomUUID } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { renderOmpReplyCard } from '../card/omp-reply-renderer';
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
type ReplyRequest = Parameters<LarkChannel['rawClient']['im']['v1']['message']['reply']>[0];
type UpdateRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['update']>[0];
type CloseRequest = Parameters<LarkChannel['rawClient']['cardkit']['v1']['card']['settings']>[0];

type PendingOperation =
  | {
      kind: 'reply';
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
      projection: string;
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
    };

const PROJECTION_THROTTLE_MS = 400;
const RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const CARD_ALREADY_BOUND = 200780;

/** Owns the one CardKit bubble used by an OMP instant-message Run. */
export class OmpReplyController {
  readonly #channel: LarkChannel;
  readonly #target: OmpReplyTarget;
  #cardId: string | undefined;
  #deliveryState: DeliveryState = 'no_message';
  #messageKnown = false;
  #sequence = 0;
  #pending: PendingOperation | undefined;
  #writer: Promise<void> = Promise.resolve();
  #latestProjection: string | undefined;
  #lastSuccessfulProjection: string | undefined;
  #projectionTimer: NodeJS.Timeout | undefined;
  #terminalRequested = false;
  #finished = false;

  constructor(input: { channel: LarkChannel; target: OmpReplyTarget }) {
    this.#channel = input.channel;
    this.#target = input.target;
  }

  async open(initialState: RunState): Promise<void> {
    if (this.#cardId || this.#deliveryState !== 'no_message') {
      throw new Error('OMP Reply is already open');
    }

    await this.enqueue(async () => {
      const { cardId } = await this.#channel.createCard(renderManagedCard(initialState));
      this.#cardId = cardId;
      const uuid = randomUUID();
      const request = {
        path: { message_id: this.#target.messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          reply_in_thread: this.#target.replyInThread ?? false,
          uuid,
        },
      } satisfies ReplyRequest;
      this.#pending = {
        kind: 'reply',
        uuid,
        sequence: 0,
        request,
        attempts: 0,
        exhausted: false,
      };
      await this.commitPending();
    });
  }

  async project(state: RunState): Promise<void> {
    if (state.terminal !== 'running') {
      throw new Error('terminal OMP state must be finished, not projected');
    }
    this.requireOpenCard();
    if (this.#terminalRequested) throw new Error('OMP Reply is finishing');

    this.#latestProjection = JSON.stringify(renderManagedCard(state));
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
    this.requireOpenCard();

    this.#terminalRequested = true;
    clearTimeout(this.#projectionTimer);
    this.#projectionTimer = undefined;
    this.#latestProjection = undefined;
    const projection = JSON.stringify(renderManagedCard(finalState));

    await this.enqueue(async () => {
      if (this.#pending) throw this.pendingError();
      await this.commitProjection(projection);
      await this.commitClose(finalState);
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
    if (!projection || projection === this.#lastSuccessfulProjection) return;
    if (this.#pending) throw this.pendingError();
    await this.commitProjection(projection);
  }

  private async commitProjection(projection: string): Promise<void> {
    if (projection === this.#lastSuccessfulProjection) return;
    const cardId = this.requireOpenCard();
    const sequence = this.#sequence + 1;
    const uuid = randomUUID();
    const request = {
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: projection },
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
    await this.commitPending();
  }

  private async commitClose(finalState: RunState): Promise<void> {
    const cardId = this.requireOpenCard();
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
    await this.commitPending();
  }

  private async commitPending(): Promise<void> {
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
        if (operation.kind !== 'reply') {
          this.#sequence = operation.sequence;
        }
        if (operation.kind === 'update') {
          this.#lastSuccessfulProjection = operation.projection;
        }
        if (operation.kind === 'close') {
          this.#deliveryState = 'delivered';
        } else {
          this.#messageKnown = true;
          this.#deliveryState = 'message_known';
        }
        this.#pending = undefined;
        return;
      }
      if (result === 'rejected') {
        operation.exhausted = true;
        this.#deliveryState = this.#messageKnown ? 'message_known' : 'not_sent';
        throw this.pendingError();
      }
      this.#deliveryState = 'unknown';
    }

    operation.exhausted = true;
    throw this.pendingError();
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
          return 'success';
        }
        if (code === CARD_ALREADY_BOUND) {
          return operation.attempts > 1 ? 'success' : 'unknown';
        }
        return code === undefined ||
          code === 0 ||
          code === 429 ||
          code === 99991400 ||
          code >= 500
          ? 'unknown'
          : 'rejected';
      }

      const result =
        operation.kind === 'update'
          ? await this.#channel.rawClient.cardkit.v1.card.update(operation.request)
          : await this.#channel.rawClient.cardkit.v1.card.settings(operation.request);
      const code = result.code;
      if (code === 0) return 'success';
      return code === undefined || code === 429 || code === 99991400 || code >= 500
        ? 'unknown'
        : 'rejected';
    } catch {
      return 'unknown';
    }
  }

  private pendingError(): Error {
    const operation = this.#pending;
    const kind = operation?.kind ?? 'unknown';
    return new Error(`OMP Reply ${kind} delivery is ${this.#deliveryState}`);
  }

  private requireOpenCard(): string {
    if (!this.#cardId) throw new Error('OMP Reply is not open');
    return this.#cardId;
  }
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

