import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ImReplyPolicy } from './im-invocation';

const ReplyTargetSchema = z.discriminatedUnion('replyInThread', [
  z.object({
    chatId: z.string().min(1),
    messageId: z.string().min(1),
    replyInThread: z.literal(false),
  }),
  z.object({
    chatId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    replyInThread: z.literal(true),
  }),
]);
const ConversationScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    id: z.string().min(1),
    chatId: z.string().min(1),
    mode: z.enum(['p2p', 'group', 'topic']),
  }),
  z.object({
    kind: z.literal('topic'),
    id: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    mode: z.literal('topic'),
  }),
]);
const SenderOwnershipSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mention'), openId: z.string().min(1) }),
  z.object({
    kind: z.literal('none'),
    reason: z.enum([
      'missing-raw-sender',
      'missing-sender-id',
      'contradictory-sender-id',
      'contradictory-sender-type',
      'unknown-sender-type',
      'direct-message',
      'verified-bot-sender',
    ]),
  }),
]);
const ReplyPolicySchema = z.object({
  invocationKind: z.literal('ordinary'),
  scope: ConversationScopeSchema,
  target: ReplyTargetSchema,
  senderOwnership: SenderOwnershipSchema,
}) satisfies z.ZodType<ImReplyPolicy>;
const DeliveryStateSchema = z.enum([
  'no_message',
  'unknown',
  'not_sent',
  'message_known',
  'delivered',
]);
const ReplyTransportSchema = z.enum(['managed', 'inline', 'markdown']);
const ReplyRequestSchema = z.object({
  path: z.object({ message_id: z.string().min(1) }),
  data: z.object({
    msg_type: z.enum(['interactive', 'post']),
    content: z.string(),
    reply_in_thread: z.boolean(),
    uuid: z.string().min(1),
  }),
});
const UpdateRequestSchema = z.object({
  path: z.object({ card_id: z.string().min(1) }),
  data: z.object({
    card: z.object({ type: z.literal('card_json'), data: z.string() }),
    sequence: z.number().int().nonnegative(),
    uuid: z.string().min(1),
  }),
});
const CloseRequestSchema = z.object({
  path: z.object({ card_id: z.string().min(1) }),
  data: z.object({
    settings: z.string(),
    sequence: z.number().int().nonnegative(),
    uuid: z.string().min(1),
  }),
});
const PatchRequestSchema = z.object({
  path: z.object({ message_id: z.string().min(1) }),
  data: z.object({ content: z.string() }),
});
const PendingOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reply'),
    transport: ReplyTransportSchema,
    terminal: z.boolean(),
    uuid: z.string().min(1),
    sequence: z.literal(0),
    request: ReplyRequestSchema,
  }),
  z.object({
    kind: z.literal('update'),
    terminal: z.boolean(),
    uuid: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    request: UpdateRequestSchema,
  }),
  z.object({
    kind: z.literal('close'),
    terminal: z.literal(true),
    uuid: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    request: CloseRequestSchema,
  }),
  z.object({
    kind: z.literal('patch'),
    terminal: z.boolean(),
    uuid: z.string().min(1),
    sequence: z.literal(0),
    request: PatchRequestSchema,
  }),
]);
const ActiveDeliverySchema = z.object({
  runId: z.string().min(1),
  replyPolicy: ReplyPolicySchema,
  cardId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  transport: ReplyTransportSchema.optional(),
  deliveryState: DeliveryStateSchema,
  nextSequence: z.number().int().positive(),
  time: z.object({
    openedAtMs: z.number().finite(),
    messageKnownAtMs: z.number().finite().optional(),
  }),
  pending: PendingOperationSchema.optional(),
});
const JournalFileSchema = z.object({ version: z.literal(2), entries: z.array(z.unknown()) });

export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export type ReplyTransport = z.infer<typeof ReplyTransportSchema>;
export type DurablePendingOperation = z.infer<typeof PendingOperationSchema>;
export type ActiveDelivery = z.infer<typeof ActiveDeliverySchema>;

export type DeliveryFailureReason =
  | 'journal-read-failed'
  | 'incompatible-journal-version'
  | 'corrupt-journal-json'
  | 'corrupt-journal-shape'
  | 'corrupt-journal-entry'
  | 'recovery-timestamp-in-future'
  | 'initial-uuid-window-expired'
  | 'message-update-window-expired'
  | 'unknown-delivery-without-operation'
  | 'managed-recovery-missing-card-id'
  | 'same-message-recovery-missing-message-id'
  | 'static-terminal-patch-rejected'
  | 'terminal-markdown-rejected'
  | 'known-message-missing-message-id'
  | 'same-message-patch-missing-message-id';

export type DeliveryFailure = Readonly<{
  runId?: string;
  reason: DeliveryFailureReason;
}>;

export class OmpDeliveryJournal {
  readonly #path: string;
  readonly #onFailure: (input: DeliveryFailure) => void;
  readonly #entries = new Map<string, ActiveDelivery>();
  #writer: Promise<void> = Promise.resolve();
  #loaded = false;
  #scanner: NodeJS.Timeout | undefined;
  #scannerWork: Promise<void> = Promise.resolve();
  readonly #claims = new Set<string>();

  constructor(input: {
    path: string;
    onFailure?: (input: DeliveryFailure) => void;
  }) {
    this.#path = input.path;
    this.#onFailure =
      input.onFailure ??
      ((failure) =>
        log.warn('reply-recovery', 'delivery-failure', {
          ...(failure.runId ? { runId: failure.runId } : {}),
          reason: failure.reason,
        }));
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      this.recordFailure(undefined, 'journal-read-failed');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.recordFailure(undefined, 'corrupt-journal-json');
      return;
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'version' in raw &&
      raw.version !== 2
    ) {
      this.recordFailure(undefined, 'incompatible-journal-version');
      return;
    }
    const file = JournalFileSchema.safeParse(raw);
    if (!file.success) {
      this.recordFailure(undefined, 'corrupt-journal-shape');
      return;
    }
    for (const item of file.data.entries) {
      const parsed = ActiveDeliverySchema.safeParse(item);
      if (parsed.success && isConsistentActiveDelivery(parsed.data)) {
        this.#entries.set(parsed.data.runId, parsed.data);
      } else {
        const runId =
          typeof item === 'object' &&
          item !== null &&
          'runId' in item &&
          typeof item.runId === 'string'
            ? item.runId
            : undefined;
        this.recordFailure(runId, 'corrupt-journal-entry');
      }
    }
  }

  claim(runId: string): void {
    this.#claims.add(runId);
  }

  release(runId: string): void {
    this.#claims.delete(runId);
  }

  isClaimed(runId: string): boolean {
    return this.#claims.has(runId);
  }

  entries(): readonly ActiveDelivery[] {
    return [...this.#entries.values()];
  }

  put(entry: ActiveDelivery): Promise<void> {
    return this.enqueue(() => this.#entries.set(entry.runId, entry));
  }

  remove(runId: string): Promise<void> {
    return this.enqueue(() => this.#entries.delete(runId));
  }

  startScanner(scan: () => Promise<void>, intervalMs = 30_000): void {
    if (this.#scanner) return;
    this.#scanner = setInterval(() => {
      const result = this.#scannerWork.then(scan);
      this.#scannerWork = result.catch((error) =>
        log.fail('reply-recovery', error, { step: 'scan' }),
      );
    }, intervalMs);
  }

  async stopScanner(): Promise<void> {
    clearInterval(this.#scanner);
    this.#scanner = undefined;
    await this.#scannerWork;
  }

  async flush(): Promise<void> {
    await this.#writer;
  }

  recordFailure(runId: string | undefined, reason: DeliveryFailureReason): void {
    this.#onFailure({ ...(runId ? { runId } : {}), reason });
  }

  private enqueue(change: () => void): Promise<void> {
    const result = this.#writer.then(async () => {
      change();
      const file = { version: 2, entries: [...this.#entries.values()] } satisfies z.input<
        typeof JournalFileSchema
      >;
      await writeFileAtomic(this.#path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    });
    this.#writer = result.catch(() => undefined);
    return result;
  }
}

function isConsistentActiveDelivery(entry: ActiveDelivery): boolean {
  const pending = entry.pending;
  if ((entry.deliveryState === 'unknown') !== Boolean(pending)) return false;
  if (
    (entry.deliveryState === 'message_known' || entry.deliveryState === 'delivered') &&
    entry.time.messageKnownAtMs === undefined
  ) {
    return false;
  }
  if (entry.deliveryState === 'no_message' && entry.messageId) return false;
  if (entry.deliveryState === 'message_known' && entry.transport === undefined) return false;
  if (entry.transport === 'managed' && entry.deliveryState === 'message_known' && !entry.cardId) {
    return false;
  }
  if (
    (entry.transport === 'inline' || entry.transport === 'markdown') &&
    entry.deliveryState === 'message_known' &&
    !entry.messageId
  ) {
    return false;
  }
  if (!pending) return true;

  if (pending.kind === 'reply') {
    return (
      entry.transport === pending.transport &&
      entry.messageId === undefined &&
      pending.uuid === pending.request.data.uuid &&
      pending.request.path.message_id === entry.replyPolicy.target.messageId &&
      pending.request.data.reply_in_thread === entry.replyPolicy.target.replyInThread
    );
  }
  if (pending.kind === 'patch') {
    return (
      entry.transport !== undefined &&
      entry.messageId !== undefined &&
      pending.request.path.message_id === entry.messageId &&
      entry.time.messageKnownAtMs !== undefined
    );
  }
  return (
    entry.transport === 'managed' &&
    entry.cardId !== undefined &&
    pending.request.path.card_id === entry.cardId &&
    pending.uuid === pending.request.data.uuid &&
    pending.sequence >= 1 &&
    pending.sequence === pending.request.data.sequence &&
    entry.nextSequence === pending.sequence + 1 &&
    entry.time.messageKnownAtMs !== undefined
  );
}
