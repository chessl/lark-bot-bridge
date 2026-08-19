import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import type { NormalizedMessage } from '@larksuite/channel';

describe('pending message queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues messages that arrive while a run is active and flushes them as the next batch', () => {
    vi.useFakeTimers();
    const flushed: Array<{ scope: string; batch: NormalizedMessage[] }> = [];
    const queue = new PendingQueue(600, (scope, batch) => flushed.push({ scope, batch }));

    queue.block('chat-1');
    expect(queue.push('chat-1', msg('m-1', 'first'))).toBe(1);
    expect(queue.push('chat-1', msg('m-2', 'second'))).toBe(2);

    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([]);

    queue.unblock('chat-1');
    vi.advanceTimersByTime(599);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([
      { scope: 'chat-1', batch: [msg('m-1', 'first'), msg('m-2', 'second')] },
    ]);
  });
});

function msg(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}
