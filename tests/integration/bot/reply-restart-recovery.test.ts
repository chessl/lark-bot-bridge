import type { LarkChannel } from '@larksuite/channel';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { initialState } from '../../../src/card/run-state.js';
import {
  type ActiveDelivery,
  type DurablePendingOperation,
  OmpDeliveryJournal,
} from '../../../src/bot/omp-delivery-journal.js';
import {
  activateOmpReplyRecovery,
  OmpReplyController,
} from '../../../src/bot/omp-reply-controller.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const NOW = 1_800_000_000_000;
const TARGET = {
  chatId: 'oc_restart',
  messageId: 'om_trigger',
  threadId: 'omt_topic',
  replyInThread: true,
} as const;
const cleanups: Array<() => Promise<void>> = [];
const journals: OmpDeliveryJournal[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const journal of journals.splice(0)) {
    await journal.stopScanner();
    await journal.flush();
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('OMP Reply restart recovery', () => {
  it('reserves the exact initial operation atomically with mode 0600 before submission', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'active-deliveries.json');
    const journal = trackedJournal(path);
    await journal.load();
    let reserved: ActiveDelivery | undefined;
    const fake = fakeChannel({
      reply: async () => {
        const disk: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (
          typeof disk === 'object' &&
          disk !== null &&
          'entries' in disk &&
          Array.isArray(disk.entries)
        ) {
          reserved = disk.entries[0] as ActiveDelivery | undefined;
        }
        return { code: 0, data: { message_id: 'om_existing' } };
      },
    });
    const reply = new OmpReplyController({
      channel: fake.channel,
      target: TARGET,
      journal,
      runId: 'run_atomic',
      now: () => NOW,
    });

    await reply.open(initialState);

    expect(reserved).toMatchObject({
      runId: 'run_atomic',
      target: TARGET,
      cardId: 'card_recovery',
      transport: 'managed',
      deliveryState: 'unknown',
      nextSequence: 1,
      time: { openedAtMs: NOW },
      pending: {
        kind: 'reply',
        transport: 'managed',
        sequence: 0,
        request: {
          path: { message_id: 'om_trigger' },
          data: { reply_in_thread: true },
        },
      },
    });
    expect(Object.keys(reserved ?? {}).sort()).toEqual([
      'cardId',
      'deliveryState',
      'nextSequence',
      'pending',
      'runId',
      'target',
      'time',
      'transport',
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('deletes no-message, delivered, and not-sent entries without network calls', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'active-deliveries.json');
    await seed(path, [
      delivery('run_none', 'no_message'),
      delivery('run_done', 'delivered'),
      delivery('run_rejected', 'not_sent'),
    ]);
    const fake = fakeChannel();
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(restarted.entries()).toEqual([]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();
  });

  it('exact-retries an unknown initial submission inside one hour and interrupts the recovered binding', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'active-deliveries.json');
    const pending = initialReplyOperation();
    await seed(path, [
      {
        ...delivery('run_initial', 'unknown'),
        cardId: 'card_original',
        transport: 'managed',
        pending,
      },
    ]);
    const fake = fakeChannel({ reply: async () => ({ code: 200780 }) });
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(fake.reply).toHaveBeenCalledOnce();
    expect(fake.reply.mock.calls[0]?.[0]).toEqual(pending.request);
    expect(fake.update).toHaveBeenCalledOnce();
    expect(fake.update.mock.calls[0]?.[0]).toMatchObject({
      path: { card_id: 'card_original' },
      data: { sequence: 1 },
    });
    expect(updatePayload(fake.update.mock.calls[0]?.[0])).toContain('运行已中断');
    expect(fake.close.mock.calls[0]?.[0]).toMatchObject({
      path: { card_id: 'card_original' },
      data: { sequence: 2 },
    });
    expect(restarted.entries()).toEqual([]);
  });

  it('terminalizes message-known managed and inline entries in their existing bubbles', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'active-deliveries.json');
    await seed(path, [
      {
        ...knownDelivery('run_managed'),
        cardId: 'card_known',
        messageId: 'om_known_managed',
        transport: 'managed',
      },
      {
        ...knownDelivery('run_inline'),
        messageId: 'om_known_inline',
        transport: 'inline',
      },
    ]);
    const fake = fakeChannel();
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update.mock.calls[0]?.[0]).toMatchObject({ path: { card_id: 'card_known' } });
    expect(fake.close.mock.calls[0]?.[0]).toMatchObject({ path: { card_id: 'card_known' } });
    expect(fake.patch).toHaveBeenCalledOnce();
    expect(fake.patch.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: 'om_known_inline' },
    });
    expect(restarted.entries()).toEqual([]);
  });

  it('recovers reservations in the final-update and close crash windows', async () => {
    const tmp = await temporaryProfile();
    const updatePath = join(tmp.profile, 'update-gap.json');
    const finalUpdate = updateOperation(7);
    await seed(updatePath, [
      {
        ...knownDelivery('run_update_gap'),
        cardId: 'card_gap',
        messageId: 'om_gap',
        transport: 'managed',
        deliveryState: 'unknown',
        nextSequence: 8,
        pending: finalUpdate,
      },
    ]);
    const updateFake = fakeChannel();
    const updateRestart = trackedJournal(updatePath);

    await activateOmpReplyRecovery({
      channel: updateFake.channel,
      journal: updateRestart,
      now: () => NOW,
    });

    expect(updateFake.update.mock.calls[0]?.[0]).toEqual(finalUpdate.request);
    expect(updateFake.update).toHaveBeenCalledTimes(2);
    expect(updateFake.update.mock.calls[1]?.[0]).toMatchObject({ data: { sequence: 8 } });
    expect(updatePayload(updateFake.update.mock.calls[1]?.[0])).toContain('运行已中断');
    expect(updateFake.close.mock.calls[0]?.[0]).toMatchObject({ data: { sequence: 9 } });
    expect(updateRestart.entries()).toEqual([]);

    const closePath = join(tmp.profile, 'close-gap.json');
    const finalClose = closeOperation(8);
    await seed(closePath, [
      {
        ...knownDelivery('run_close_gap'),
        cardId: 'card_gap',
        messageId: 'om_gap',
        transport: 'managed',
        deliveryState: 'unknown',
        nextSequence: 9,
        pending: finalClose,
      },
    ]);
    const closeFake = fakeChannel();
    const closeRestart = trackedJournal(closePath);

    await activateOmpReplyRecovery({
      channel: closeFake.channel,
      journal: closeRestart,
      now: () => NOW,
    });

    expect(closeFake.close.mock.calls[0]?.[0]).toEqual(finalClose.request);
    expect(closeFake.update).toHaveBeenCalledOnce();
    expect(closeFake.update.mock.calls[0]?.[0]).toMatchObject({ data: { sequence: 9 } });
    expect(updatePayload(closeFake.update.mock.calls[0]?.[0])).toContain('运行已中断');
    expect(closeFake.close.mock.calls[1]?.[0]).toMatchObject({ data: { sequence: 10 } });
    expect(closeRestart.entries()).toEqual([]);
  });

  it('retries the unresolved head every 30 seconds without changing identity', async () => {
    vi.useFakeTimers();
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'active-deliveries.json');
    const pending = initialReplyOperation();
    await seed(path, [
      {
        ...delivery('run_scanner', 'unknown'),
        cardId: 'card_scanner',
        transport: 'managed',
        pending,
      },
    ]);
    let attempts = 0;
    const fake = fakeChannel({
      reply: async () => (++attempts === 1 ? {} : { code: 200780 }),
    });
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });
    expect(fake.reply).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledOnce());

    expect(fake.reply).toHaveBeenCalledTimes(2);
    expect(fake.reply.mock.calls[1]?.[0]).toEqual(fake.reply.mock.calls[0]?.[0]);
    expect(fake.update).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('fails closed on expired and corrupt state without a network call', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'expired.json');
    const failures: Array<{ runId?: string; reason: string }> = [];
    await seed(path, [
      {
        ...delivery('run_expired_initial', 'unknown'),
        cardId: 'card_expired',
        transport: 'managed',
        time: { openedAtMs: NOW - 60 * 60 * 1_000 - 1 },
        pending: initialReplyOperation(),
      },
      {
        ...knownDelivery('run_expired_known'),
        time: { openedAtMs: NOW - 20 * 86_400_000, messageKnownAtMs: NOW - 14 * 86_400_000 - 1 },
      },
    ]);
    const fake = fakeChannel();
    const expired = trackedJournal(path, failures);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: expired, now: () => NOW });

    expect(failures).toEqual([
      { runId: 'run_expired_initial', reason: 'initial-uuid-window-expired' },
      { runId: 'run_expired_known', reason: 'message-update-window-expired' },
    ]);
    expect(expired.entries()).toEqual([]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();

    const corruptPath = join(tmp.profile, 'corrupt.json');
    await writeFile(corruptPath, '{ definitely not json', { mode: 0o600 });
    const corruptFailures: Array<{ runId?: string; reason: string }> = [];
    const corrupt = trackedJournal(corruptPath, corruptFailures);
    await activateOmpReplyRecovery({ channel: fake.channel, journal: corrupt, now: () => NOW });
    expect(corruptFailures).toEqual([{ reason: 'corrupt-journal-json' }]);
    expect(fake.close).not.toHaveBeenCalled();

    const mismatchPath = join(tmp.profile, 'identity-mismatch.json');
    await writeFile(
      mismatchPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...knownDelivery('run_identity_mismatch'),
            cardId: 'card_A',
            transport: 'managed',
            deliveryState: 'unknown',
            nextSequence: 8,
            pending: {
              kind: 'update',
              terminal: true,
              uuid: 'uuid_U1',
              sequence: 7,
              request: {
                path: { card_id: 'card_B' },
                data: {
                  card: { type: 'card_json', data: '{}' },
                  sequence: 9,
                  uuid: 'uuid_U2',
                },
              },
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const mismatchFailures: Array<{ runId?: string; reason: string }> = [];
    const mismatch = trackedJournal(mismatchPath, mismatchFailures);
    await activateOmpReplyRecovery({ channel: fake.channel, journal: mismatch, now: () => NOW });
    expect(mismatchFailures).toEqual([
      { runId: 'run_identity_mismatch', reason: 'corrupt-journal-entry' },
    ]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();
  });
});

async function temporaryProfile(): Promise<TmpProfile> {
  const tmp = await createTmpProfile('reply-restart-');
  cleanups.push(tmp.cleanup);
  return tmp;
}

function trackedJournal(
  path: string,
  failures?: Array<{ runId?: string; reason: string }>,
): OmpDeliveryJournal {
  const journal = new OmpDeliveryJournal({
    path,
    ...(failures ? { onFailure: (failure) => failures.push(failure) } : {}),
  });
  journals.push(journal);
  return journal;
}

async function seed(path: string, entries: readonly ActiveDelivery[]): Promise<void> {
  const journal = new OmpDeliveryJournal({ path });
  await journal.load();
  for (const entry of entries) await journal.put(entry);
  await journal.flush();
}

function delivery(runId: string, deliveryState: ActiveDelivery['deliveryState']): ActiveDelivery {
  return {
    runId,
    target: TARGET,
    deliveryState,
    nextSequence: 1,
    time: { openedAtMs: NOW - 1_000 },
  };
}

function knownDelivery(runId: string): ActiveDelivery {
  return {
    ...delivery(runId, 'message_known'),
    messageId: `om_${runId}`,
    transport: 'inline',
    time: { openedAtMs: NOW - 2_000, messageKnownAtMs: NOW - 1_000 },
  };
}

function initialReplyOperation(): DurablePendingOperation {
  return {
    kind: 'reply',
    transport: 'managed',
    terminal: false,
    uuid: 'uuid_initial_exact',
    sequence: 0,
    request: {
      path: { message_id: TARGET.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: 'card_original' } }),
        reply_in_thread: true,
        uuid: 'uuid_initial_exact',
      },
    },
  };
}

function updateOperation(sequence: number): DurablePendingOperation {
  return {
    kind: 'update',
    terminal: true,
    uuid: 'uuid_final_update',
    sequence,
    request: {
      path: { card_id: 'card_gap' },
      data: {
        card: { type: 'card_json', data: JSON.stringify({ terminal: 'done' }) },
        sequence,
        uuid: 'uuid_final_update',
      },
    },
  };
}

function closeOperation(sequence: number): DurablePendingOperation {
  return {
    kind: 'close',
    terminal: true,
    uuid: 'uuid_final_close',
    sequence,
    request: {
      path: { card_id: 'card_gap' },
      data: {
        settings: JSON.stringify({ streaming_mode: false }),
        sequence,
        uuid: 'uuid_final_close',
      },
    },
  };
}

function fakeChannel(options: { reply?: (input: unknown) => Promise<unknown> } = {}): {
  channel: LarkChannel;
  reply: Mock;
  update: Mock;
  close: Mock;
  patch: Mock;
} {
  const reply = vi.fn(options.reply ?? (async () => ({ code: 0, data: { message_id: 'om_reply' } })));
  const update = vi.fn(async () => ({ code: 0 }));
  const close = vi.fn(async () => ({ code: 0 }));
  const patch = vi.fn(async () => ({ code: 0 }));
  const channel = {
    rawClient: {
      im: { v1: { message: { reply, patch } } },
      cardkit: { v1: { card: { update, settings: close } } },
    },
    async createCard() {
      return { cardId: 'card_recovery' };
    },
  } as unknown as LarkChannel;
  return { channel, reply, update, close, patch };
}

function updatePayload(input: unknown): string {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('data' in input) ||
    typeof input.data !== 'object' ||
    input.data === null ||
    !('card' in input.data) ||
    typeof input.data.card !== 'object' ||
    input.data.card === null ||
    !('data' in input.data.card) ||
    typeof input.data.card.data !== 'string'
  ) {
    return '';
  }
  return input.data.card.data;
}
