import { Client } from '@larksuiteoapi/node-sdk';
import { resolveAppPaths } from '../config/app-paths';
import { resolveAppSecret } from '../config/secret-resolver';
import { log } from '../core/logger';
import { resolveProfileRuntime } from '../runtime/profile-runtime';

/**
 * Pre-flight for the in-meeting agent. The probe uses the same native SDK
 * client as the runtime so installing or binding lark-cli is never required.
 */

/** Early-bird group to request the allowlisted beta (error 20017). */
export const MEETING_BETA_CHAT_URL =
  'https://go.larkoffice.com/join-chat/2f4nb0e1-fe00-4f67-bed7-25beaf533fbd';

/**
 * App-identity scopes the feature needs. They are granted independently, and
 * hitting one does not imply the others — joining works with just
 * `bot.join:write`, but posting into the meeting then fails until
 * `message:write` is granted too (observed as an HTTP 400).
 */
export const MEETING_REQUIRED_SCOPES = [
  { scope: 'vc:meeting.bot.join:write', purpose: '让 bot 入会 / 离会' },
  { scope: 'vc:meeting.message:write', purpose: '在会中发消息（回答会发不出去）' },
  { scope: 'vc:meeting.meetingevent:read', purpose: '读会中事件（字幕/弹幕/进退会）' },
];

/** Events the app must subscribe to (长连接 mode) for push to arrive. */
export const MEETING_REQUIRED_EVENTS = [
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
];

export type MeetingPreflightStatus =
  | 'ok'
  /** App-level scope missing — fixable via `consoleUrl`. */
  | 'scope-missing'
  /** Allowlisted beta not enabled for this app (20017). */
  | 'not-in-beta'
  /** Probe could not run (missing live bot identity, config, or network). */
  | 'unknown';

export interface MeetingPreflight {
  status: MeetingPreflightStatus;
  message: string;
  /** Scopes the app is missing, verbatim from the API. */
  missingScopes: string[];
  /**
   * Feishu scope-apply URL, verbatim from the API response. Opaque — render as
   * link/QR only; never edit, re-encode or rebuild it.
   */
  consoleUrl?: string;
  /** Events that must be subscribed for push (cannot be queried via API). */
  requiredEvents: string[];
  /**
   * All app scopes the feature needs, with what each unlocks. The probe can
   * only report the scope it happened to trip on, so the console shows the full
   * set — granting them together avoids a second round-trip.
   */
  requiredScopes: { scope: string; purpose: string }[];
  /** Beta sign-up link, present when `status === 'not-in-beta'`. */
  betaChatUrl?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

const ACTIVE_MEETING_URL = '/open-apis/vc/v1/bots/user_active_meeting';
const MEETING_QUERY_SCOPE = 'vc:meeting.bot.join:write';

interface MeetingProbeClient {
  request(payload: {
    method: string;
    url: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
}

export type PreflightClientFactory = (input: {
  appId: string;
  appSecret: string;
  tenant: 'feishu' | 'lark';
}) => MeetingProbeClient;

const defaultClientFactory: PreflightClientFactory = ({ appId, appSecret, tenant }) =>
  new Client({
    appId,
    appSecret,
    domain: tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-bot-bridge',
  });

function scopeApplyUrl(tenant: 'feishu' | 'lark', appId: string, scope: string): string {
  const base = tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const query = new URLSearchParams({ clientID: appId, scopes: scope });
  return `${base}/page/scope-apply?${query}`;
}

function permissionScopes(error: Record<string, unknown>): string[] {
  if (!Array.isArray(error.permission_violations)) return [];
  return error.permission_violations.flatMap((violation) => {
    if (!isRecord(violation) || typeof violation.subject !== 'string') return [];
    return violation.subject ? [violation.subject] : [];
  });
}

function responseBody(error: unknown): Record<string, unknown> | undefined {
  if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.data)) {
    return undefined;
  }
  return error.response.data;
}

function classifyNativeResponse(
  value: unknown,
  appId: string,
  tenant: 'feishu' | 'lark',
): MeetingPreflight {
  if (!isRecord(value)) return classifyPreflight(value);
  const code = typeof value.code === 'number' ? value.code : 0;
  if (code === 0) return classifyPreflight({ ok: true });
  const detail = isRecord(value.error) ? value.error : {};
  const scopes = permissionScopes(detail);
  if (code === 99991672 && scopes.length === 0) scopes.push(MEETING_QUERY_SCOPE);
  return classifyPreflight({
    ok: false,
    error: {
      code,
      message: typeof value.msg === 'string' ? value.msg : `权限检查失败 (${code})`,
      missing_scopes: scopes,
      ...(scopes[0] ? { console_url: scopeApplyUrl(tenant, appId, scopes[0]) } : {}),
    },
  });
}

/**
 * Classify a normalized VC probe response. Exported because the permission
 * envelope and beta-gate distinction are the behavior worth pinning down.
 */
export function classifyPreflight(payload: unknown): MeetingPreflight {
  const base = {
    missingScopes: [] as string[],
    requiredEvents: MEETING_REQUIRED_EVENTS,
    requiredScopes: MEETING_REQUIRED_SCOPES,
  };
  if (!isRecord(payload)) {
    return { ...base, status: 'unknown', message: '无法解析权限检查响应' };
  }
  if (payload.ok === true) {
    return { ...base, status: 'ok', message: '应用身份权限已就绪' };
  }
  const err = isRecord(payload.error) ? payload.error : {};
  const code = typeof err.code === 'number' ? err.code : undefined;
  const subtype = typeof err.subtype === 'string' ? err.subtype : '';
  const message = typeof err.message === 'string' ? err.message : '权限检查失败';
  const consoleUrl = typeof err.console_url === 'string' ? err.console_url : undefined;
  const missingScopes = strings(err.missing_scopes);

  // 20017 / ErrNotInGray — the capability itself isn't open for this app yet,
  // so no amount of scope granting helps.
  if (code === 20017 || /ErrNotInGray/i.test(message) || /not.?in.?gray/i.test(subtype)) {
    return {
      ...base,
      status: 'not-in-beta',
      message: '智能体入会能力尚未对本应用开通（内测灰度）',
      betaChatUrl: MEETING_BETA_CHAT_URL,
    };
  }
  if (subtype === 'app_scope_not_applied' || code === 99991672 || missingScopes.length > 0) {
    return {
      ...base,
      status: 'scope-missing',
      message,
      missingScopes: missingScopes.length ? missingScopes : ['vc:meeting.bot.join:write'],
      ...(consoleUrl ? { consoleUrl } : {}),
    };
  }
  return {
    ...base,
    status: 'unknown',
    message,
    ...(consoleUrl ? { consoleUrl } : {}),
  };
}

export interface MeetingPreflightInput {
  profile: string;
  rootDir?: string;
  /** Any user open_id; the probe needs one but never acts on it. */
  probeUserId?: string;
}

/** Run the native read-only probe and classify the result. */
export async function checkMeetingPreflight(
  input: MeetingPreflightInput,
  createClient: PreflightClientFactory = defaultClientFactory,
): Promise<MeetingPreflight> {
  const base = {
    missingScopes: [] as string[],
    requiredEvents: MEETING_REQUIRED_EVENTS,
    requiredScopes: MEETING_REQUIRED_SCOPES,
  };
  if (!input.probeUserId) {
    return { ...base, status: 'unknown', message: 'bot 尚未连接，无法取得权限探测身份' };
  }

  try {
    const runtime = await resolveProfileRuntime({
      profile: input.profile,
      ...(input.rootDir
        ? { config: resolveAppPaths({ rootDir: input.rootDir, profile: input.profile }).configFile }
        : {}),
      allowBootstrap: false,
    });
    const appId = runtime.cfg.accounts.app.id;
    const tenant = runtime.cfg.accounts.app.tenant;
    const client = createClient({
      appId,
      appSecret: await resolveAppSecret(runtime.cfg, runtime.appPaths),
      tenant,
    });

    let payload: unknown;
    try {
      payload = await client.request({
        method: 'GET',
        url: ACTIVE_MEETING_URL,
        params: { user_id: input.probeUserId },
      });
    } catch (error) {
      payload = responseBody(error);
      if (!payload) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, status: 'unknown', message };
      }
    }

    const result = classifyNativeResponse(payload, appId, tenant);
    log.info('meeting', 'preflight', {
      status: result.status,
      missing: result.missingScopes.length,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, status: 'unknown', message };
  }
}
