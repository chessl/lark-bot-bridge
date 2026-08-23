import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import { renderCard } from '../card/run-renderer';
import type { RunState } from '../card/run-state';

export interface OmpReplyTarget {
  messageId: string;
  replyInThread?: boolean;
}

/** Owns the one CardKit bubble used by an OMP instant-message Run. */
export class OmpReplyController {
  readonly #channel: LarkChannel;
  readonly #target: OmpReplyTarget;
  #cardId: string | undefined;
  #sequence = 0;
  #finished = false;

  constructor(input: { channel: LarkChannel; target: OmpReplyTarget }) {
    this.#channel = input.channel;
    this.#target = input.target;
  }

  async open(initialState: RunState): Promise<void> {
    if (this.#cardId) throw new Error('OMP Reply is already open');

    const { cardId } = await this.#channel.createCard(renderManagedCard(initialState));
    const result = await this.#channel.rawClient.im.v1.message.reply({
      path: { message_id: this.#target.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        reply_in_thread: this.#target.replyInThread ?? false,
        uuid: randomUUID(),
      },
    });
    if (!result.data?.message_id?.trim()) {
      throw new Error('initial OMP Reply is ambiguous: missing message receipt');
    }
    this.#cardId = cardId;
  }

  async project(state: RunState): Promise<void> {
    if (state.terminal !== 'running') {
      throw new Error('terminal OMP state must be finished, not projected');
    }
    await this.#channel.updateCardById(
      this.requireOpenCard(),
      renderManagedCard(state),
      ++this.#sequence,
    );
  }

  async finish(finalState: RunState): Promise<void> {
    if (finalState.terminal === 'running') throw new Error('cannot finish a running OMP Reply');
    if (this.#finished) throw new Error('OMP Reply is already finished');

    const cardId = this.requireOpenCard();
    await this.#channel.updateCardById(cardId, renderManagedCard(finalState), ++this.#sequence);

    const result = await this.#channel.rawClient.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({
          streaming_mode: false,
          summary: { content: summaryFor(finalState) },
        }),
        sequence: ++this.#sequence,
        uuid: randomUUID(),
      },
    });
    if (result.code !== undefined && result.code !== 0) {
      throw new Error(`CardKit settings failed: code=${result.code} msg=${result.msg ?? '<none>'}`);
    }
    this.#finished = true;
  }

  private requireOpenCard(): string {
    if (!this.#cardId) throw new Error('OMP Reply is not open');
    return this.#cardId;
  }
}

function renderManagedCard(state: RunState): object {
  return {
    ...renderCard(state),
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
