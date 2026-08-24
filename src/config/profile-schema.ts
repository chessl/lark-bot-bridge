import type { AppCredentials, AppPreferences, SecretInput } from './schema';

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
export interface TrustedPeerBot {
  alias: string;
  openId: string;
}

export type PersonalSubstitutionConfig =
  | Readonly<{ enabled: false; targetOpenIds: string[] }>
  | Readonly<{ enabled: true; targetOpenIds: [string, ...string[]] }>;

export interface CollaborationConfig {
  trustedPeerBots: TrustedPeerBot[];
  personalSubstitution: PersonalSubstitutionConfig;
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
  app: AppCredentials;
  preferences: AppPreferences;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  omp: OmpConfig;
  attachments: AttachmentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  collaboration: CollaborationConfig;
}

export interface RootConfig {
  schemaVersion: 3;
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  app: AppCredentials;
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  omp?: OmpConfig;
}

export function createDefaultProfileConfig(input: CreateDefaultProfileConfigInput): ProfileConfig {
  return normalizeProfileConfig({
    ...input,
    omp: input.omp ?? { binaryPath: process.env.LARK_CHANNEL_OMP_BIN ?? 'omp' },
    collaboration: {
      trustedPeerBots: [],
      personalSubstitution: { enabled: false, targetOpenIds: [] },
    },
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    mode?: unknown;
    app?: unknown;
    preferences?: AppPreferences;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
    };
    omp?: OmpConfig;
    attachments?: Partial<AttachmentConfig>;
    meeting?: unknown;
    collaboration?: unknown;
  };

  const app = normalizeApp(raw.app);
  if (!raw.omp) {
    throw new Error('omp profile requires omp configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(raw.access);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const meeting = normalizeMeeting(raw.meeting);
  const collaboration = normalizeCollaboration(raw.collaboration);

  return {
    mode: raw.mode === 'team' ? 'team' : 'personal',
    app,
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
    collaboration,
  };
}

const TRUSTED_PEER_ALIAS = /^[\p{L}\p{N}_-]{1,32}$/u;
const APP_SCOPED_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const RESERVED_PEER_ALIASES: Record<string, true> = {
  all: true,
  everyone: true,
  here: true,
};

export function normalizeTrustedPeerBots(
  input: unknown,
  currentBotOpenId?: string,
): TrustedPeerBot[] {
  if (!Array.isArray(input) || input.length > 10) {
    throw new Error('trusted peer count must be between 0 and 10');
  }
  const aliases = new Set<string>();
  const openIds = new Set<string>();
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('trusted peer entry is invalid');
    }
    const alias =
      'alias' in entry && typeof entry.alias === 'string' ? entry.alias : undefined;
    const openId =
      'openId' in entry && typeof entry.openId === 'string' ? entry.openId : undefined;
    if (alias === undefined || openId === undefined) {
      throw new Error('trusted peer entry is invalid');
    }
    const aliasKey = alias.normalize('NFKC').toLowerCase();
    if (
      alias !== alias.trim() ||
      !TRUSTED_PEER_ALIAS.test(alias) ||
      !TRUSTED_PEER_ALIAS.test(aliasKey) ||
      [...aliasKey].length > 32
    ) {
      throw new Error('trusted peer alias is invalid');
    }
    if (RESERVED_PEER_ALIASES[aliasKey]) {
      throw new Error('trusted peer alias is reserved');
    }
    if (aliases.has(aliasKey)) {
      throw new Error('trusted peer alias is duplicated');
    }
    if (!APP_SCOPED_OPEN_ID.test(openId)) {
      throw new Error('trusted peer open ID is invalid');
    }
    if (openIds.has(openId)) {
      throw new Error('trusted peer open ID is duplicated');
    }
    if (currentBotOpenId && openId === currentBotOpenId) {
      throw new Error('current Bot cannot be a trusted peer');
    }
    aliases.add(aliasKey);
    openIds.add(openId);
    return { alias, openId };
  });
}

export function normalizePersonalSubstitution(input: unknown): PersonalSubstitutionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('collaboration personalSubstitution is required');
  }
  if (
    !('enabled' in input) ||
    typeof input.enabled !== 'boolean' ||
    !('targetOpenIds' in input) ||
    !Array.isArray(input.targetOpenIds)
  ) {
    throw new Error('collaboration personalSubstitution is invalid');
  }
  if (input.targetOpenIds.length > 10) {
    throw new Error('personal substitution target count must be between 0 and 10');
  }
  const openIds = new Set<string>();
  const targetOpenIds = input.targetOpenIds.map((value) => {
    if (typeof value !== 'string' || !APP_SCOPED_OPEN_ID.test(value)) {
      throw new Error('personal substitution target open ID is invalid');
    }
    if (openIds.has(value)) {
      throw new Error('personal substitution target open ID is duplicated');
    }
    openIds.add(value);
    return value;
  });
  if (input.enabled) {
    const [first, ...rest] = targetOpenIds;
    if (first === undefined) {
      throw new Error('enabled personal substitution requires at least one target');
    }
    return { enabled: true, targetOpenIds: [first, ...rest] };
  }
  return { enabled: false, targetOpenIds };
}

function normalizeCollaboration(input: unknown): CollaborationConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('profile collaboration configuration is required');
  }
  const raw = input as {
    trustedPeerBots?: unknown;
    personalSubstitution?: unknown;
  };
  return {
    trustedPeerBots: normalizeTrustedPeerBots(raw.trustedPeerBots),
    personalSubstitution: normalizePersonalSubstitution(raw.personalSubstitution),
  };
}

function normalizeApp(input: unknown): AppCredentials {
  if (!input || typeof input !== 'object') {
    throw new Error('app credentials are required');
  }
  const app = input as { id?: unknown; secret?: unknown; tenant?: unknown };
  if (typeof app.id !== 'string' || !app.id || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('app credentials are incomplete');
  }
  return {
    id: app.id,
    secret: normalizeSecret(app.secret),
    tenant: app.tenant,
  };
}

function normalizeSecret(input: unknown): SecretInput {
  if (typeof input === 'string' && input) return input;
  if (!input || typeof input !== 'object') throw new Error('app secret is missing');
  const ref = input as { source?: unknown; provider?: unknown; id?: unknown };
  if (typeof ref.id !== 'string' || !ref.id) throw new Error('app secret reference is incomplete');
  if (ref.source === 'keystore') return { source: 'keystore', id: ref.id };
  if (ref.source === 'exec' && ref.provider === 'bridge') {
    return { source: 'keystore', id: ref.id };
  }
  if (ref.source === 'env') return `\${${ref.id}}`;
  throw new Error(`unsupported app secret source: ${String(ref.source)}`);
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  if (!preferences) return {};
  const { model, maxConcurrentRuns, runIdleTimeoutMinutes, agentStopGraceMs } = preferences;
  return {
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof maxConcurrentRuns === 'number' ? { maxConcurrentRuns } : {}),
    ...(typeof runIdleTimeoutMinutes === 'number' ? { runIdleTimeoutMinutes } : {}),
    ...(typeof agentStopGraceMs === 'number' ? { agentStopGraceMs } : {}),
  };
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
