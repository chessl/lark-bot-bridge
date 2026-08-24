import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  type ActiveDelivery,
  type DeliveryFailure,
  type DurablePendingOperation,
  OmpDeliveryJournal,
} from '../../../src/bot/omp-delivery-journal.js';
import {
  activateOmpReplyRecovery,
  OmpReplyController,
} from '../../../src/bot/omp-reply-controller.js';
import type { ImReplyPolicy } from '../../../src/bot/im-invocation.js';
import { initialState } from '../../../src/card/run-state.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const NOW = 1_800_000_000_000;
const TARGET = {
  chatId: 'oc_restart',
  messageId: 'om_trigger',
  threadId: 'omt_topic',
  replyInThread: true,
} as const;
const REPLY_POLICY: ImReplyPolicy = {
  invocationKind: 'ordinary',
  scope: {
    kind: 'topic',
    id: 'oc_restart:omt_topic',
    chatId: 'oc_restart',
    threadId: 'omt_topic',
    mode: 'topic',
  },
  target: TARGET,
  senderOwnership: { kind: 'mention', openId: 'ou_sender' },
};
const SUBSTITUTION_REPLY_POLICY: ImReplyPolicy = {
  invocationKind: 'substitution',
  scope: REPLY_POLICY.scope,
  target: TARGET,
  senderOwnership: { kind: 'mention', openId: 'ou_sender' },
  substitutionTargets: [
    { openId: 'ou_target', displayAlias: 'Target' },
    { openId: 'ou_second', displayAlias: 'Second' },
  ],
  invalidTargetCount: 2,
};
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
      replyPolicy: REPLY_POLICY,
      journal,
      runId: 'run_atomic',
      now: () => NOW,
    });

    await reply.open(initialState);

    expect(reserved).toMatchObject({
      runId: 'run_atomic',
      replyPolicy: REPLY_POLICY,
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
      'replyPolicy',
      'runId',
      'time',
      'transport',
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('recovers no-message and not-sent entries as one terminal Reply each', async () => {
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
    expect(fake.reply).toHaveBeenCalledTimes(2);
    for (const call of fake.reply.mock.calls) {
      const payload = JSON.stringify(replyPayload(call[0]));
      expect(payload).toContain('"tag":"at"');
      expect(payload.match(/ou_sender/g)).toHaveLength(1);
    }
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();
  });

  it('recovers substitution interruption with sender ownership only', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'substitution-interrupted.json');
    await seed(path, [
      {
        runId: 'run_substitution_interrupted',
        replyPolicy: SUBSTITUTION_REPLY_POLICY,
        deliveryState: 'no_message',
        nextSequence: 1,
        time: { openedAtMs: NOW - 1_000 },
      },
    ]);
    const fake = fakeChannel();
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(fake.reply).toHaveBeenCalledOnce();
    const payload = JSON.stringify(replyPayload(fake.reply.mock.calls[0]?.[0]));
    expect(payload.match(/ou_sender/g)).toHaveLength(1);
    expect(payload).not.toMatch(/ou_target|ou_second|另有 2 个|AI 代|回答（已在本回复中点名）/);
    expect(restarted.entries()).toEqual([]);
  });

  it('exact-retries a durable combined substitution terminal request without recomputing policy', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'substitution-exact-retry.json');
    const pending: DurablePendingOperation = {
      kind: 'reply',
      transport: 'markdown',
      terminal: true,
      uuid: 'uuid_substitution_exact',
      sequence: 0,
      request: {
        path: { message_id: TARGET.messageId },
        data: {
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [
                [{ tag: 'at', user_id: 'ou_sender' }],
                [
                  { tag: 'text', text: 'AI 代 ' },
                  { tag: 'at', user_id: 'ou_target' },
                  { tag: 'text', text: '、' },
                  { tag: 'at', user_id: 'ou_second' },
                  { tag: 'text', text: ' 回答（已在本回复中点名）' },
                ],
                [{ tag: 'text', text: '另有 2 个对象身份无法确认，未代答。' }],
                [
                  { tag: 'md', text: 'before ' },
                  { tag: 'at', user_id: 'ou_peer' },
                  { tag: 'md', text: ' after' },
                ],
              ],
            },
          }),
          reply_in_thread: true,
          uuid: 'uuid_substitution_exact',
        },
      },
    };
    await seed(path, [
      {
        runId: 'run_substitution_exact',
        replyPolicy: SUBSTITUTION_REPLY_POLICY,
        transport: 'markdown',
        deliveryState: 'unknown',
        nextSequence: 1,
        time: { openedAtMs: NOW - 1_000 },
        pending,
      },
    ]);
    const fake = fakeChannel();
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(fake.reply).toHaveBeenCalledOnce();
    expect(fake.reply.mock.calls[0]?.[0]).toEqual(pending.request);
    const replay = JSON.stringify(fake.reply.mock.calls[0]?.[0]);
    expect(replay.match(/ou_sender/g)).toHaveLength(1);
    expect(replay.match(/ou_target/g)).toHaveLength(1);
    expect(replay.match(/ou_second/g)).toHaveLength(1);
    expect(replay.match(/ou_peer/g)).toHaveLength(1);
    expect(replay.indexOf('ou_target')).toBeLessThan(replay.indexOf('ou_second'));
    expect(replay).toContain('另有 2 个对象身份无法确认');
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();
    expect(restarted.entries()).toEqual([]);
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

  it('replays the frozen plain fallback after an exact terminal Mention rejection', async () => {
    const tmp = await temporaryProfile();
    const path = join(tmp.profile, 'mention-fallback.json');
    const mentionFallback = {
      kind: 'patch',
      terminal: true,
      uuid: 'uuid_plain_fallback',
      sequence: 0,
      request: {
        path: { message_id: 'om_known_peer' },
        data: { content: '{"plain":"\\\\@Hermes","status":"Peer 未通知"}' },
      },
    } as const;
    const pending = {
      ...updateOperation(7),
      mentionFallback,
    } satisfies DurablePendingOperation;
    await seed(path, [
      {
        ...knownDelivery('run_peer_fallback'),
        cardId: 'card_gap',
        messageId: 'om_known_peer',
        transport: 'managed',
        deliveryState: 'unknown',
        nextSequence: 8,
        pending,
      },
    ]);
    const fake = fakeChannel({
      update: async () => ({ code: 230001, msg: 'mention rejected' }),
    });
    const restarted = trackedJournal(path);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: restarted, now: () => NOW });

    expect(fake.update).toHaveBeenCalledOnce();
    expect(fake.update.mock.calls[0]?.[0]).toEqual(pending.request);
    expect(fake.patch).toHaveBeenCalledOnce();
    expect(fake.patch.mock.calls[0]?.[0]).toEqual(mentionFallback.request);
    expect(fake.reply).not.toHaveBeenCalled();
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
    const managedPayload = updatePayload(fake.update.mock.calls[0]?.[0]);
    const inlinePayload = JSON.stringify(fake.patch.mock.calls[0]?.[0]);
    for (const payload of [managedPayload, inlinePayload]) {
      expect(payload.match(/ou_sender/g)).toHaveLength(1);
      expect(payload).not.toContain('调用工具 0 次');
      expect(payload).not.toContain('工具 0');
    }
  });

  it('exact-retries reservations in the final-update and close crash windows', async () => {
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
    expect(updateFake.update).toHaveBeenCalledOnce();
    expect(updateFake.update.mock.calls[0]?.[0]).toEqual(finalUpdate.request);
    expect(updateFake.close).toHaveBeenCalledOnce();
    expect(updateFake.close.mock.calls[0]?.[0]).toMatchObject({ data: { sequence: 8 } });
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

    expect(closeFake.close).toHaveBeenCalledOnce();
    expect(closeFake.close.mock.calls[0]?.[0]).toEqual(finalClose.request);
    expect(closeFake.update).not.toHaveBeenCalled();
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
    const failures: DeliveryFailure[] = [];
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
      {
        ...delivery('run_future_initial', 'unknown'),
        cardId: 'card_future',
        transport: 'managed',
        time: { openedAtMs: NOW + 1 },
        pending: initialReplyOperation(),
      },
      {
        ...knownDelivery('run_future_known'),
        time: { openedAtMs: NOW - 1_000, messageKnownAtMs: NOW + 1 },
      },
    ]);
    const fake = fakeChannel();
    const expired = trackedJournal(path, failures);

    await activateOmpReplyRecovery({ channel: fake.channel, journal: expired, now: () => NOW });

    expect(failures).toEqual([
      { runId: 'run_expired_initial', reason: 'initial-uuid-window-expired' },
      { runId: 'run_expired_known', reason: 'message-update-window-expired' },
      { runId: 'run_future_initial', reason: 'recovery-timestamp-in-future' },
      { runId: 'run_future_known', reason: 'recovery-timestamp-in-future' },
    ]);
    expect(expired.entries()).toEqual([]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();

    const corruptPath = join(tmp.profile, 'corrupt.json');
    await writeFile(corruptPath, '{ definitely not json', { mode: 0o600 });
    const corruptFailures: DeliveryFailure[] = [];
    const corrupt = trackedJournal(corruptPath, corruptFailures);
    await activateOmpReplyRecovery({ channel: fake.channel, journal: corrupt, now: () => NOW });
    expect(corruptFailures).toEqual([{ reason: 'corrupt-journal-json' }]);
    expect(fake.close).not.toHaveBeenCalled();

    const mismatchPath = join(tmp.profile, 'identity-mismatch.json');
    await writeFile(
      mismatchPath,
      JSON.stringify({
        version: 2,
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
          {
            ...knownDelivery('run_known_missing_transport'),
            transport: undefined,
          },
          {
            ...knownDelivery('run_patch_missing_transport'),
            transport: undefined,
            deliveryState: 'unknown',
            pending: {
              kind: 'patch',
              terminal: true,
              uuid: 'uuid_patch',
              sequence: 0,
              request: {
                path: { message_id: 'om_run_patch_missing_transport' },
                data: { content: '{}' },
              },
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const mismatchFailures: DeliveryFailure[] = [];
    const mismatch = trackedJournal(mismatchPath, mismatchFailures);
    await activateOmpReplyRecovery({ channel: fake.channel, journal: mismatch, now: () => NOW });
    expect(mismatchFailures).toEqual([
      { runId: 'run_identity_mismatch', reason: 'corrupt-journal-entry' },
      { runId: 'run_known_missing_transport', reason: 'corrupt-journal-entry' },
      { runId: 'run_patch_missing_transport', reason: 'corrupt-journal-entry' },
    ]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.patch).not.toHaveBeenCalled();

    const oldPath = join(tmp.profile, 'old-journal.json');
    await writeFile(oldPath, JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
    const oldFailures: DeliveryFailure[] = [];
    const old = trackedJournal(oldPath, oldFailures);
    await activateOmpReplyRecovery({ channel: fake.channel, journal: old, now: () => NOW });
    expect(oldFailures).toEqual([{ reason: 'incompatible-journal-version' }]);
  });
});

async function temporaryProfile(): Promise<TmpProfile> {
  const tmp = await createTmpProfile('reply-restart-');
  cleanups.push(tmp.cleanup);
  return tmp;
}

function trackedJournal(path: string, failures?: DeliveryFailure[]): OmpDeliveryJournal {
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
    replyPolicy: REPLY_POLICY,
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

function updateOperation(
  sequence: number,
): Extract<DurablePendingOperation, { kind: 'update' }> {
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

function fakeChannel(
  options: {
    reply?: (input: unknown) => Promise<unknown>;
    update?: (input: unknown) => Promise<unknown>;
    patch?: (input: unknown) => Promise<unknown>;
  } = {},
): {
  channel: LarkChannel;
  reply: Mock;
  update: Mock;
  close: Mock;
  patch: Mock;
} {
  const reply = vi.fn(
    options.reply ?? (async () => ({ code: 0, data: { message_id: 'om_reply' } })),
  );
  const update = vi.fn(options.update ?? (async () => ({ code: 0 })));
  const close = vi.fn(async () => ({ code: 0 }));
  const patch = vi.fn(options.patch ?? (async () => ({ code: 0 })));
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

function replyPayload(input: unknown): unknown {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('data' in input) ||
    typeof input.data !== 'object' ||
    input.data === null ||
    !('content' in input.data) ||
    typeof input.data.content !== 'string'
  ) {
    return undefined;
  }
  return JSON.parse(input.data.content);
}
