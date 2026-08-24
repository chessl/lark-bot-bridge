import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { modelLabel, normalizeModelSelection } from '../agent/models';
import {
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
  buildAgentPrompt,
} from '../agent/prompt';
import type { AgentEvent, OmpRunEngine } from '../agent/types';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { handleCardAction } from '../card/dispatcher';
import {
  createRunState,
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  type RunMetricReceipt,
  type RunState,
  reduceWithClock,
} from '../card/run-state';
import { type Controls, isKnownTextCommand, tryHandleCommand } from '../commands';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { getAgentStopGraceMs, getMaxConcurrentRuns, getRunIdleTimeoutMs } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { NativeLarkServer } from '../lark-native/server';
import { toPolicyAttachment, toPromptAttachment } from '../media/attachment';
import { type LocalAttachment, MediaCache } from '../media/cache';
import type { VcRequestClient } from '../meeting/api';
import { MeetingManager } from '../meeting/manager';
import { attachMeetingAgent, summarizeEndedMeeting } from '../meeting/orchestrator';
import { canUseDm, canUseGroup, requireMentionForChat } from '../policy/access';
import { createOwnerRefreshController } from '../policy/owner';
import type { ScopeContext } from '../policy/run-policy';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns } from './active-runs';
import { type ChatMode, ChatModeCache } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import {
  createImInvocation,
  finalizeImReply,
  type ImConversationScope,
  type ImInvocation,
  type ImOrdinaryMessagePlan,
  type ImPromptMessage,
  planImMessage,
} from './im-invocation';
import { startKeepalive } from './keepalive';
import { fetchKnownChats } from './lark-info';
import { OmpDeliveryJournal } from './omp-delivery-journal';
import { activateOmpReplyRecovery, OmpReplyController } from './omp-reply-controller';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { type ScopedRun, ScopedRuns } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { lookupMessageThreadId } from './thread-id';

const DEBOUNCE_MS = 600;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '本次运行已注入 lark_bridge MCP 工具；飞书读写、用户授权和发卡片都直接使用这些工具。',
  '不要执行 lark-cli，也不要绕过 MCP 工具访问飞书 API 或凭据。',
  '写操作会由 bridge 在飞书里请求确认；用户明确请求后再调用即可。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
  activateDeliveryRecovery?(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: ProfileConfig;
  agent: OmpRunEngine;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  deliveryJournal?: OmpDeliveryJournal;
  appPaths?: Pick<
    AppPaths,
    | 'rootDir'
    | 'secretsFile'
    | 'keystoreSaltFile'
    | 'mediaDir'
    | 'callbackNoncesFile'
    | 'activeDeliveriesFile'
  >;
  wallNow?: () => number;
  monoNow?: () => number;
  deferDeliveryRecovery?: boolean;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const wallNow = deps.wallNow ?? Date.now;
  const monoNow = deps.monoNow ?? performance.now.bind(performance);
  const messageReceipts = new WeakMap<NormalizedMessage, RunMetricReceipt>();
  const imPlans = new WeakMap<NormalizedMessage, ImOrdinaryMessagePlan>();
  const seenImMessageIds = new Set<string>();
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.callbackNoncesFile
    ? new CallbackNonceStore(deps.appPaths.callbackNoncesFile)
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        secret: appSecret,
        nonceStore: callbackNonceStore,
      })
    : undefined;
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  const opts: LarkChannelOptions = {
    appId: cfg.app.id,
    appSecret,
    domain: cfg.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-bot-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  const deliveryJournal =
    deps.deliveryJournal ??
    (deps.appPaths?.activeDeliveriesFile
      ? new OmpDeliveryJournal({ path: deps.appPaths.activeDeliveriesFile })
      : undefined);
  await deliveryJournal?.load();
  let deliveryRecoveryActivated = false;
  const activateDeliveryRecovery = async (): Promise<void> => {
    if (!deliveryJournal || deliveryRecoveryActivated) return;
    deliveryRecoveryActivated = true;
    await activateOmpReplyRecovery({ channel, journal: deliveryJournal });
  };
  const nativeServer = await NativeLarkServer.start({
    profile: controls.profile,
    rootDir: deps.appPaths?.rootDir,
    channel,
    callbackAuth,
    profileConfig: () => controls.cfg,
  });
  const scopedRuns = new ScopedRuns({
    agent,
    pool,
    activeRuns,
    nativeTools: nativeServer,
    ...(sessionCatalog ? { sessionCatalog } : {}),
    workspaces,
    profile: controls.profile,
    profileConfig: () => controls.cfg,
    stopGraceMs: () => getAgentStopGraceMs(controls.cfg),
  });
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const scopeRunTails = new Map<string, Promise<void>>();
  const scopeRunCounts = new Map<string, number>();
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    enqueueScopeRun(scope, () =>
      withTrace({ chatId: firstMsg.chatId }, async () => {
        log.info('flush', 'start', {
          scope,
          batchSize: batch.length,
          chatId: firstMsg.chatId,
          threadId: firstMsg.threadId,
          msgId: firstMsg.messageId,
        });
        try {
          const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
          // Feishu/Lark converted topic groups may still resolve as `group` from
          // the chat info API/cache, while message events already carry threadId.
          // Treat threadId as authoritative for IM messages so scope and replies
          // stay isolated per topic.
          const mode = firstMsg.threadId ? 'topic' : resolvedMode;
          if (firstMsg.threadId && resolvedMode !== 'topic') {
            chatModeCache.invalidate(firstMsg.chatId);
            logThreadModeOverride({
              chatId: firstMsg.chatId,
              resolvedMode,
              threadId: firstMsg.threadId,
            });
          }
          const plans = batch.map((message) => {
            const existing = imPlans.get(message);
            if (existing) return existing;
            const fallback = planImMessage({
              message,
              scope: conversationScope(scope, message.chatId, mode, message.threadId),
              authorized: true,
              duplicate: false,
              mentionRequired: false,
              recognizedCommand: false,
              currentBotOpenId: channel.botIdentity?.openId,
              trustedPeerBots: controls.cfg.collaboration.trustedPeerBots,
            });
            if (fallback.lane !== 'ordinary') {
              throw new Error('queued IM message did not produce an ordinary plan');
            }
            return fallback;
          });
          const firstPlan = plans[0];
          if (!firstPlan) return;
          const invocation = createImInvocation(
            [firstPlan, ...plans.slice(1)],
            channel.botIdentity,
          );
          await runAgentBatch({
            channel,
            scopedRuns,
            sessions,
            sessionCatalog,
            media,
            deliveryJournal,
            invocation,
            controls,
            lastRunModelByScope,
            messageReceipts,
            monoNow,
          });
        } finally {
          log.info('flush', 'end');
        }
      }),
    );
  });

  function enqueueScopeRun(scope: string, task: () => Promise<void>): void {
    const count = (scopeRunCounts.get(scope) ?? 0) + 1;
    scopeRunCounts.set(scope, count);
    if (count === 1) pending.block(scope);

    const previous = scopeRunTails.get(scope) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((err) => log.fail('flush', err, { scope }))
      .finally(() => {
        const remaining = (scopeRunCounts.get(scope) ?? 1) - 1;
        if (remaining === 0) {
          scopeRunCounts.delete(scope);
          pending.unblock(scope);
        } else {
          scopeRunCounts.set(scope, remaining);
        }
        if (scopeRunTails.get(scope) === next) scopeRunTails.delete(scope);
      });
    scopeRunTails.set(scope, next);
  }

  const enqueueInvocation = (invocation: ImInvocation): void => {
    enqueueScopeRun(invocation.scope.id, () =>
      runAgentBatch({
        channel,
        scopedRuns,
        sessions,
        sessionCatalog,
        media,
        deliveryJournal,
        invocation,
        controls,
        lastRunModelByScope,
        messageReceipts,
        monoNow,
      }),
    );
  };

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      const receivedAtWall = wallNow();
      const receivedAtMono = monoNow();
      messageReceipts.set(msg, {
        receivedAtWall,
        receivedAtMono,
        ...(Number.isFinite(msg.createTime) ? { messageCreatedAtWall: msg.createTime } : {}),
      });
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          scopedRuns,
          imPlans,
          seenImMessageIds,
          messageReceipts,
          enqueueInvocation,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          workspaces,
          agent,
          scopedRuns,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          nativeApproval: nativeServer,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          sessions,
          scopedRuns,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.cfg.meeting;
  let meetingManager: MeetingManager | undefined;
  if (meetingConfig().enabled) {
    meetingManager = new MeetingManager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel,
          controls,
          scopedRuns,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel,
          controls,
          scopedRuns,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  try {
    await channel.connect();
  } catch (error) {
    await nativeServer.close();
    throw error;
  }
  if (!deps.deferDeliveryRecovery) await activateDeliveryRecovery();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    activateDeliveryRecovery,
    channel,
    disconnect: async () => {
      scopedRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      await deliveryJournal?.stopScanner();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      controls.meeting = undefined;
      pending.cancelAll();
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        scopedRuns.stopAll(),
        nativeServer.close(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
        deliveryJournal?.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

function startKnownChatsRefreshTimer(channel: LarkChannel, controls: Controls): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/**
 * The SDK normalizes a merge_forward whose sub-messages it could not fetch
 * to this sentinel, distinct from a genuinely empty forward.
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' && msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: OmpRunEngine;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  scopedRuns: ScopedRuns;
  imPlans: WeakMap<NormalizedMessage, ImOrdinaryMessagePlan>;
  seenImMessageIds: Set<string>;
  messageReceipts: WeakMap<NormalizedMessage, RunMetricReceipt>;
  enqueueInvocation: (invocation: ImInvocation) => void;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

function conversationScope(
  id: string,
  chatId: string,
  mode: ChatMode,
  threadId: string | undefined,
): ImConversationScope {
  return mode === 'topic' && threadId
    ? Object.freeze({ kind: 'topic', id, chatId, threadId, mode })
    : Object.freeze({ kind: 'chat', id, chatId, mode });
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    scopedRuns,
    imPlans,
    seenImMessageIds,
    messageReceipts,
    enqueueInvocation,
  } = deps;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId ? `${msg.chatId}:${threadId}` : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.cfg, controls, msg.senderId)
      : canUseGroup(controls.cfg, controls, msg.chatId, msg.senderId);
  const plan = planImMessage({
    message: emsg,
    scope: conversationScope(scope, msg.chatId, chatMode, threadId),
    authorized: accessDecision.ok,
    duplicate: seenImMessageIds.has(msg.messageId),
    mentionRequired:
      msg.chatType !== 'p2p' &&
      requireMentionForChat(controls.cfg, msg.chatId) &&
      !msg.mentionedBot,
    recognizedCommand: isKnownTextCommand(msg.content),
    currentBotOpenId: channel.botIdentity?.openId,
    trustedPeerBots: controls.cfg.collaboration.trustedPeerBots,
  });
  log.info('intake.route', plan.reason, {
    scope,
    lane: plan.lane,
    ...(plan.lane === 'ordinary' || plan.lane === 'peer' ? { kind: plan.lane } : {}),
    ...(plan.lane === 'peer' ? { alias: plan.peer.alias } : {}),
  });

  if (plan.lane === 'drop') {
    if (
      plan.allowAccessHint &&
      plan.reason === 'access-denied' &&
      !accessDecision.ok &&
      msg.chatType !== 'p2p' &&
      accessDecision.reason === 'denied-chat' &&
      msg.mentionedBot
    ) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  seenImMessageIds.add(msg.messageId);
  const plannedMessage = plan.source.message;
  const receipt = messageReceipts.get(msg);
  if (receipt) messageReceipts.set(plannedMessage, receipt);

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (plan.lane !== 'peer' && isForwardFetchFailed(plannedMessage)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: plannedMessage.messageId,
      chatType: plannedMessage.chatType,
    });
    await sendForwardFetchFailedHint(
      channel,
      plannedMessage.chatId,
      plannedMessage.messageId,
    ).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    return;
  }

  if (plan.lane === 'peer') {
    const invocation = createImInvocation([plan]);
    enqueueInvocation(invocation);
    log.info('intake', 'peer-enqueued', {
      scope,
      kind: invocation.kind,
      alias: invocation.peerAlias,
    });
    return;
  }

  if (plan.lane === 'command') {
    const handled = await tryHandleCommand({
      channel,
      msg: plannedMessage,
      scope,
      chatMode,
      sessions,
      workspaces,
      agent,
      sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg: plannedMessage,
        scope,
        mode: chatMode,
        workspaces,
        controls,
        access: accessDecision,
      }),
      scopedRuns,
      controls,
    });
    if (handled) {
      const dropped = pending.cancel(scope);
      log.info('intake', 'command', { scope, droppedPending: dropped.length });
      return;
    }
    throw new Error('recognized human Command was not handled');
  }

  imPlans.set(plannedMessage, plan);
  const size = pending.push(scope, plannedMessage);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

interface RunBatchDeps {
  channel: LarkChannel;
  scopedRuns: ScopedRuns;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  media: MediaCache;
  invocation: ImInvocation;
  controls: Controls;
  deliveryJournal?: OmpDeliveryJournal;
  lastRunModelByScope: Map<string, string>;
  messageReceipts: WeakMap<NormalizedMessage, RunMetricReceipt>;
  monoNow: () => number;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    scopedRuns,
    sessions,
    sessionCatalog,
    media,
    invocation,
    controls,
    deliveryJournal,
    lastRunModelByScope,
    messageReceipts,
    monoNow,
  } = deps;
  const [firstSource, ...remainingSources] = invocation.sourceMessages;
  const lastSource = remainingSources[remainingSources.length - 1] ?? firstSource;
  const batch = [firstSource, ...remainingSources].map((source) => source.message);
  const firstMsg = firstSource.message;
  const lastMsg = lastSource.message;
  const scope = invocation.scope.id;
  const mode = invocation.scope.mode;
  const replyTarget = invocation.replyTarget;
  const chatId = invocation.scope.chatId;
  const threadId = invocation.scope.kind === 'topic' ? invocation.scope.threadId : undefined;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets =
    invocation.kind === 'ordinary'
      ? [
          ...new Set(
            batch
              .map((m) => replyQuoteTargetForMessage(m, mode))
              .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
          ),
        ]
      : [];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  resourceItems.push(...quotes.flatMap((quote) => quote.resources));
  const attachments = await media.resolve(resourceItems, controls.cfg.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  const hasTopicSession = sessionCatalog
    ?.entries()
    .some((entry) => entry.scopeId === scope && entry.status === 'active');
  if (invocation.kind === 'ordinary' && mode === 'topic' && threadId && !hasTopicSession) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. The scoped-run seam owns translating this preference into the
  // adapter's model argument.
  const modelPref = controls.cfg.preferences.model;
  const modelSelection = normalizeModelSelection(modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const extraInstructions = modelSwitched
    ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
      ]
    : undefined;

  const prompt = buildPrompt(invocation, attachments, quotes, topicContext, extraInstructions);
  log.info('prompt.invocation', invocation.promptPolicy.reason, {
    kind: invocation.kind,
    scope,
    batchSize: invocation.sourceMessages.length,
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // A message-carried thread ID is authoritative even when cached Chat
  // metadata still says group; without the native option, the Reply escapes
  // to the Chat top level.
  const sendOpts = {
    replyTo: replyTarget.messageId,
    ...(replyTarget.replyInThread ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId: replyTarget.chatId,
    threadId: replyTarget.replyInThread ? replyTarget.threadId : undefined,
    replyTo: replyTarget.messageId,
    replyInThread: replyTarget.replyInThread,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.cfg, controls, firstMsg.senderId)
      : canUseGroup(controls.cfg, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    chatType: firstMsg.chatType,
    messageId: lastMsg.messageId,
    actorId: lastMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const flow = await scopedRuns.start({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { run } = flow;
  const { cwdRealpath: cwd, resumeFrom } = run.metadata;
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const state = createRunState(messageReceipts.get(lastMsg));
  const reply = new OmpReplyController({
    channel,
    replyPolicy: invocation.replyPolicy,
    ...(deliveryJournal
      ? {
          journal: deliveryJournal,
          runId: run.metadata.runId,
        }
      : {}),
  });
  let onItReactionId = await addMessageReaction(channel, lastMsg.messageId, 'OnIt');
  try {
    await reply.open(state);
    const finalState = await processAgentStream(
      run,
      run.events,
      scope,
      idleTimeoutMs,
      async (nextState) => {
        if (nextState.terminal === 'running') await reply.project(nextState);
      },
      state,
      monoNow,
    );
    await reply.finish(finalizeImReply(invocation, finalState));
    if (onItReactionId) {
      await removeMessageReaction(channel, lastMsg.messageId, onItReactionId);
      onItReactionId = undefined;
    }
    if (finalState.terminal === 'done') {
      await addMessageReaction(channel, lastMsg.messageId, 'Done');
    }
  } catch (err) {
    log.fail('reply', err, { scope, step: 'im' });
    await run.stop().catch((stopErr) =>
      log.warn('reply', 'stop-failed', {
        scope,
        err: stopErr instanceof Error ? stopErr.message : String(stopErr),
      }),
    );
  } finally {
    if (onItReactionId) {
      await removeMessageReaction(channel, lastMsg.messageId, onItReactionId);
    }
    reply.release();
  }
}

async function addMessageReaction(
  channel: LarkChannel,
  messageId: string,
  emojiType: 'OnIt' | 'Done',
): Promise<string | undefined> {
  try {
    const response = await channel.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    const reactionId = response.data?.reaction_id;
    if (!reactionId) {
      log.warn('reaction', 'add-missing-id', { messageId, emojiType });
    }
    return reactionId;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      emojiType,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function removeMessageReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reduce the ordered OMP event stream and project each visible state.
 */
async function processAgentStream(
  run: ScopedRun,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  flush: (state: RunState) => Promise<void>,
  startState: RunState = initialState,
  monoNow: () => number = () => performance.now(),
): Promise<RunState> {
  let state = startState;

  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — the agent can legitimately be silent while a long-running tool call
  // waits for external input. There is then no agent stream activity until the
  // tool returns. Track unmatched tool_use ids and pause the watchdog while any
  // are in flight.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  try {
    for await (const evt of events) {
      if (run.wasInterrupted()) break;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();

      if (evt.type === 'usage') {
        const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = evt;
        log.info('agent', 'usage', {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        });
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduceWithClock(state, evt, monoNow);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state; the OMP process may
      // still need a short cleanup tail before stdout closes.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "OMP finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    const terminalAtMono = monoNow();
    if (idleFired) {
      state = markIdleTimeout(state, terminalAtMono);
    } else if (run.wasInterrupted()) {
      state = markInterrupted(state, terminalAtMono);
    } else {
      state = finalizeIfRunning(state, terminalAtMono);
    }
  }
  log.info('card', 'final', {
    scope,
    terminal: state.terminal,
    interrupted: run.wasInterrupted(),
  });
  await flush(state);
  if (run.wasInterrupted()) await run.stop();
  return state;
}

function buildPrompt(
  invocation: ImInvocation,
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  extraInstructions?: string[],
): string {
  const policy = invocation.promptPolicy;
  const promptMessages = policy.kind === 'ordinary' ? policy.messages : [policy.message];
  const fileKeys = promptMessages.flatMap((message) => message.resourceFileKeys);
  const texts =
    policy.kind === 'ordinary'
      ? policy.messages
          .map((message) => {
            const text = stripAttachmentRefs(message.content, fileKeys).trim();
            if (!text) return '';
            return policy.messages.length > 1 ? `${senderAnnotation(message)} ${text}` : text;
          })
          .filter(Boolean)
      : [stripAttachmentRefs(policy.message.content, fileKeys).trim()].filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const ordinaryContext =
    policy.kind === 'ordinary'
      ? (() => {
          const first = policy.messages[0];
          const senderType: 'user' | 'bot' | undefined =
            first.sender.kind === 'human'
              ? 'user'
              : first.sender.kind === 'bot'
                ? 'bot'
                : undefined;
          const mentions = mergeMentions(policy.messages);
          return {
            senderId: first.senderId,
            ...(first.senderName ? { senderName: first.senderName } : {}),
            ...(senderType ? { senderType } : {}),
            ...(policy.botIdentity?.openId ? { botOpenId: policy.botIdentity.openId } : {}),
            ...(mentions.length > 0 ? { mentions } : {}),
            messageIds: policy.messages.map((message) => message.messageId),
          };
        })()
      : {
          senderId: `@${policy.message.senderAlias}`,
          senderName: policy.message.senderAlias,
          senderType: 'bot' as const,
          messageIds: [policy.message.messageId],
        };
  const peerInstructions =
    policy.kind === 'peer'
      ? [
          `本次是可信 peer @${policy.message.senderAlias} 发起的隔离调用。冻结的可信 alias 为: ${policy.trustedPeerAliases
            .map((alias) => `@${alias}`)
            .join('、') || '无'}。只返回答案正文;transport 不会激活任何 alias,本次保持 zero-hop。`,
        ]
      : [];

  return buildAgentPrompt({
    context: {
      chatId: invocation.scope.chatId,
      chatType: invocation.scope.mode === 'p2p' ? 'p2p' : 'group',
      ...ordinaryContext,
      ...(invocation.scope.kind === 'topic' ? { threadId: invocation.scope.threadId } : {}),
      source: 'im',
    },
    instructions: [
      ...BRIDGE_AGENT_INSTRUCTIONS,
      ...peerInstructions,
      ...(extraInstructions ?? []),
    ],
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: promptMessages.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

function senderAnnotation(message: ImPromptMessage): string {
  const name = message.senderName ?? message.senderId;
  const type =
    message.sender.kind === 'human' ? 'user' : message.sender.kind === 'bot' ? 'bot' : undefined;
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: readonly ImPromptMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const message of batch) {
    for (const mention of message.mentions) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(msg: NormalizedMessage, mode: ChatMode): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: readonly string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(message: {
  messageId: string;
  interactiveCard?: unknown;
}): BridgePromptInteractiveCard | undefined {
  if (message.interactiveCard === undefined) return undefined;
  return {
    messageId: message.messageId,
    content: message.interactiveCard,
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
