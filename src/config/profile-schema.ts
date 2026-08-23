import type { AppCredentials, AppPreferences, MessageReplyMode, SecretsConfig } from './schema';

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
}

export interface OmpConfig {
  binaryPath: string;
  profile?: string;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

/**
 * Deployment mode. Personal profiles allow user OAuth only inside private
 * chats; team profiles expose bot identity only. Admin commands remain gated
 * in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export interface ProfileConfig {
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  omp: OmpConfig;
  attachments: AttachmentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  secrets?: SecretsConfig;
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  secrets?: SecretsConfig;
  omp?: OmpConfig;
}

export function createDefaultProfileConfig(input: CreateDefaultProfileConfigInput): ProfileConfig {
  return normalizeProfileConfig({
    ...input,
    omp: input.omp ?? { binaryPath: process.env.LARK_CHANNEL_OMP_BIN ?? 'omp' },
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: AppPreferences;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
    };
    omp?: OmpConfig;
    attachments?: Partial<AttachmentConfig>;
    meeting?: unknown;
  };

  const accounts = normalizeAccounts(raw.accounts);
  if (!raw.omp) {
    throw new Error('omp profile requires omp configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(raw.access);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const meeting = normalizeMeeting(raw.meeting);

  return {
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    omp: normalizeOmp(raw.omp),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    meeting,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(access: Partial<ProfileAccess> | undefined): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? true,
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(
  input: { default?: unknown } | undefined,
): ProfileConfig['workspaces'] {
  const defaultWorkspace =
    typeof input?.default === 'string' && input.default.trim() ? input.default.trim() : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeOmp(input: OmpConfig): OmpConfig {
  if (typeof input.binaryPath !== 'string' || !input.binaryPath.trim()) {
    throw new Error('omp.binaryPath is required');
  }
  const profile = typeof input.profile === 'string' ? input.profile.trim() : '';
  return {
    binaryPath: input.binaryPath,
    ...(profile ? { profile } : {}),
  };
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger =
    typeof raw.trigger === 'string' && raw.trigger.trim()
      ? raw.trigger.trim()
      : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(
        raw.transcript?.stabilizeMs,
        0,
        30_000,
        MEETING_DEFAULTS.transcript.stabilizeMs,
      ),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
