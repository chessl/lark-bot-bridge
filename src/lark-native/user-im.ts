import { readFile } from 'node:fs/promises';
import { Client, withUserAccessToken } from '@larksuiteoapi/node-sdk';
import { resolveAppPaths } from '../config/app-paths';
import { withConfigFileLock } from '../config/profile-store';
import type { TenantBrand } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveProfileRuntime } from '../runtime/profile-runtime';
import { type CredentialStore, OsKeychain } from './keychain';

export interface UserImContext {
  profile: string;
  rootDir?: string;
  client?: Client;
  credentialStore?: CredentialStore;
}

export interface UserAuthStatus {
  loggedIn: boolean;
  userName?: string;
  openId?: string;
  scopes: string[];
}

export interface DeviceLogin {
  verificationUrl: string;
  userCode?: string;
  deviceCode: string;
  expiresIn?: number;
}

export interface UserChat {
  id: string;
  name: string;
}

export interface UserChatsPage {
  chats: UserChat[];
  nextPageToken?: string;
}

export interface AddBotResult {
  ok: boolean;
  pending: boolean;
  needAuth?: boolean;
  message?: string;
}

export const LIST_CHAT_SCOPES = ['im:chat:read'];
export const ADD_BOT_SCOPES = ['im:chat.members:write_only'];

const REFRESH_AHEAD_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 8;
const REQUEST_TIMEOUT_MS = 30_000;

interface StoredToken {
  version: 1;
  appId: string;
  openId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scopes: string[];
}

interface UserMetadata {
  version: 1;
  appId: string;
  openId: string;
  userName: string;
  scopes: string[];
}

interface DeviceState {
  profile: string;
  appId: string;
  scopes: string[];
  expiresAt: number;
}

interface NativeContext {
  profile: string;
  tenant: TenantBrand;
  appId: string;
  appSecret: string;
  client: Client;
  authFile: string;
  authLockTarget: string;
  credentialStore: CredentialStore;
}

const deviceStates = new Map<string, DeviceState>();

export async function getUserAuthStatus(ctx: UserImContext): Promise<UserAuthStatus> {
  const native = await resolveNativeContext(ctx);
  const metadata = await readMetadata(native.authFile);
  if (!metadata || metadata.appId !== native.appId) return { loggedIn: false, scopes: [] };
  try {
    await validUserAccessToken(native, metadata);
    return {
      loggedIn: true,
      userName: metadata.userName,
      openId: metadata.openId,
      scopes: metadata.scopes,
    };
  } catch (error) {
    if (error instanceof UserAuthorizationRequired) return { loggedIn: false, scopes: [] };
    throw error;
  }
}

export function hasScope(status: UserAuthStatus, anyOf: string[]): boolean {
  return anyOf.some((scope) => status.scopes.includes(scope));
}

export async function startDeviceLogin(
  ctx: UserImContext,
  scopes: string[] = LIST_CHAT_SCOPES,
): Promise<DeviceLogin> {
  const native = await resolveNativeContext(ctx);
  const current = await readMetadata(native.authFile);
  const requestedScopes = unique([
    ...scopes,
    ...(current?.appId === native.appId ? current.scopes : []),
    'offline_access',
  ]);
  const response = await fetchJson(oauthEndpoints(native.tenant).deviceAuthorization, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${native.appId}:${native.appSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: native.appId,
      scope: requestedScopes.join(' '),
    }),
  });
  const deviceCode = stringField(response, 'device_code');
  const verificationUrl =
    stringField(response, 'verification_uri_complete') || stringField(response, 'verification_uri');
  if (!deviceCode || !verificationUrl) {
    throw new Error(oauthError(response, '无法开始用户授权'));
  }
  const expiresIn = numberField(response, 'expires_in') ?? 240;
  deviceStates.set(deviceCode, {
    profile: native.profile,
    appId: native.appId,
    scopes: requestedScopes,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  const userCode = stringField(response, 'user_code');
  return {
    verificationUrl,
    deviceCode,
    ...(userCode ? { userCode } : {}),
    expiresIn,
  };
}

export async function completeDeviceLogin(
  ctx: UserImContext,
  deviceCode: string,
): Promise<{ ok: boolean; message?: string }> {
  const native = await resolveNativeContext(ctx);
  const state = deviceStates.get(deviceCode);
  if (!state || state.profile !== native.profile || state.appId !== native.appId) {
    return { ok: false, message: '授权请求不存在或 bridge 已重启，请重新开始授权' };
  }
  if (state.expiresAt <= Date.now()) {
    deviceStates.delete(deviceCode);
    return { ok: false, message: '授权链接已过期，请重新开始授权' };
  }
  const response = await fetchJson(oauthEndpoints(native.tenant).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: native.appId,
      client_secret: native.appSecret,
    }),
  });
  const error = stringField(response, 'error');
  if (error === 'authorization_pending' || error === 'slow_down') {
    return { ok: false, message: '授权尚未完成，请先在浏览器里确认授权后重试' };
  }
  if (error) {
    if (error === 'access_denied' || error === 'expired_token' || error === 'invalid_grant') {
      deviceStates.delete(deviceCode);
    }
    return { ok: false, message: oauthError(response, '用户授权失败') };
  }
  const accessToken = stringField(response, 'access_token');
  if (!accessToken)
    return { ok: false, message: oauthError(response, '授权响应缺少 access_token') };

  const identity = await fetchUserIdentity(native.client, accessToken);
  const now = Date.now();
  const grantedScopes = unique(
    (stringField(response, 'scope') || state.scopes.join(' ')).split(/\s+/).filter(Boolean),
  );
  const token: StoredToken = {
    version: 1,
    appId: native.appId,
    openId: identity.openId,
    accessToken,
    refreshToken: stringField(response, 'refresh_token'),
    expiresAt: now + (numberField(response, 'expires_in') ?? 7200) * 1000,
    refreshExpiresAt:
      now +
      (numberField(response, 'refresh_token_expires_in') ??
        (stringField(response, 'refresh_token') ? 7 * 24 * 3600 : 7200)) *
        1000,
    scopes: grantedScopes,
  };
  const metadata: UserMetadata = {
    version: 1,
    appId: native.appId,
    openId: identity.openId,
    userName: identity.name,
    scopes: grantedScopes,
  };
  await withConfigFileLock(native.authLockTarget, async () => {
    const previous = await readMetadata(native.authFile);
    await native.credentialStore.set(
      tokenAccount(token.appId, token.openId),
      JSON.stringify(token),
    );
    await writeFileAtomic(native.authFile, `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
    if (previous && (previous.appId !== token.appId || previous.openId !== token.openId)) {
      await native.credentialStore.remove(tokenAccount(previous.appId, previous.openId));
    }
  });
  deviceStates.delete(deviceCode);
  return { ok: true };
}

export async function listUserChats(
  ctx: UserImContext,
  opts: { pageSize?: number; pageToken?: string } = {},
): Promise<UserChatsPage> {
  const native = await resolveNativeContext(ctx);
  const token = await validUserAccessToken(native);
  const response = await native.client.im.v1.chat.list(
    {
      params: {
        sort_type: 'ByActiveTimeDesc',
        page_size: opts.pageSize ?? DEFAULT_PAGE_SIZE,
        ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
      },
    },
    withUserAccessToken(token),
  );
  assertApiResponse(response, '列出群失败');
  return chatPage(response.data);
}

export async function searchUserChats(
  ctx: UserImContext,
  opts: { query: string; pageSize?: number; pageToken?: string },
): Promise<UserChatsPage> {
  const native = await resolveNativeContext(ctx);
  const token = await validUserAccessToken(native);
  const response = await native.client.im.v1.chat.search(
    {
      params: {
        query: opts.query,
        page_size: opts.pageSize ?? DEFAULT_PAGE_SIZE,
        ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
      },
    },
    withUserAccessToken(token),
  );
  assertApiResponse(response, '搜索群失败');
  return chatPage(response.data);
}

export async function addBotToChat(
  ctx: UserImContext,
  chatId: string,
  botAppId: string,
): Promise<AddBotResult> {
  const native = await resolveNativeContext(ctx);
  const token = await validUserAccessToken(native);
  const response = await native.client.im.v1.chatMembers.create(
    {
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: [botAppId] },
    },
    withUserAccessToken(token),
  );
  if (response.code !== undefined && response.code !== 0) {
    return {
      ok: false,
      pending: false,
      message: `把 bot 拉进群失败：${response.msg ?? response.code}`,
    };
  }
  const data = response.data;
  if (data?.invalid_id_list?.includes(botAppId) || data?.not_existed_id_list?.includes(botAppId)) {
    return {
      ok: false,
      pending: false,
      message: '把 bot 拉进群失败：应用对该群不可用，或缺少群成员权限',
    };
  }
  if ((data?.pending_approval_id_list?.length ?? 0) > 0) {
    return { ok: true, pending: true, message: '已发送，等待群主/管理员通过' };
  }
  return { ok: true, pending: false };
}

export async function logoutUser(ctx: UserImContext): Promise<void> {
  const native = await resolveNativeContext(ctx);
  await withConfigFileLock(native.authLockTarget, async () => {
    const metadata = await readMetadata(native.authFile);
    if (!metadata || metadata.appId !== native.appId) return;
    const raw = await native.credentialStore.get(tokenAccount(metadata.appId, metadata.openId));
    const token = parseStoredToken(raw);
    if (token?.accessToken) {
      await fetchJson(oauthEndpoints(native.tenant).revoke, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: native.appId,
          client_secret: native.appSecret,
          token: token.accessToken,
          token_type_hint: 'access_token',
        }),
      }).catch(() => undefined);
    }
    await native.credentialStore.remove(tokenAccount(metadata.appId, metadata.openId));
    await writeFileAtomic(native.authFile, '{}\n', { mode: 0o600 });
  });
}

async function resolveNativeContext(ctx: UserImContext): Promise<NativeContext> {
  const runtime = await resolveProfileRuntime({
    profile: ctx.profile,
    ...(ctx.rootDir
      ? { config: resolveAppPaths({ rootDir: ctx.rootDir, profile: ctx.profile }).configFile }
      : {}),
    allowBootstrap: false,
  });
  const appSecret = await resolveAppSecret(runtime.cfg, runtime.appPaths);
  const tenant = runtime.cfg.accounts.app.tenant;
  const domain = tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return {
    profile: runtime.appPaths.profile,
    tenant,
    appId: runtime.cfg.accounts.app.id,
    appSecret,
    client:
      ctx.client ??
      new Client({
        appId: runtime.cfg.accounts.app.id,
        appSecret,
        domain,
        source: 'lark-bot-bridge',
      }),
    authFile: runtime.appPaths.userAuthFile,
    authLockTarget: runtime.appPaths.userAuthLockTarget(runtime.cfg.accounts.app.id),
    credentialStore: ctx.credentialStore ?? new OsKeychain(),
  };
}

async function validUserAccessToken(
  native: NativeContext,
  knownMetadata?: UserMetadata,
): Promise<string> {
  return withConfigFileLock(native.authLockTarget, async () => {
    const metadata = knownMetadata ?? (await readMetadata(native.authFile));
    if (!metadata || metadata.appId !== native.appId) throw new UserAuthorizationRequired();
    const account = tokenAccount(metadata.appId, metadata.openId);
    const stored = parseStoredToken(await native.credentialStore.get(account));
    if (!stored || stored.appId !== metadata.appId || stored.openId !== metadata.openId) {
      throw new UserAuthorizationRequired();
    }
    const now = Date.now();
    if (stored.expiresAt - REFRESH_AHEAD_MS > now) return stored.accessToken;
    if (!stored.refreshToken || stored.refreshExpiresAt <= now) {
      await native.credentialStore.remove(account);
      throw new UserAuthorizationRequired();
    }
    const response = await fetchJson(oauthEndpoints(native.tenant).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: native.appId,
        client_secret: native.appSecret,
      }),
    });
    const code = numberField(response, 'code');
    const accessToken = stringField(response, 'access_token');
    if (code !== 0 || !accessToken) {
      if (isTerminalRefreshFailure(response)) await native.credentialStore.remove(account);
      throw new UserAuthorizationRequired(oauthError(response, '用户授权刷新失败'));
    }
    const updated: StoredToken = {
      ...stored,
      accessToken,
      refreshToken: stringField(response, 'refresh_token') || stored.refreshToken,
      expiresAt: now + (numberField(response, 'expires_in') ?? 7200) * 1000,
      refreshExpiresAt:
        now +
        (numberField(response, 'refresh_token_expires_in') ??
          Math.max(0, Math.floor((stored.refreshExpiresAt - now) / 1000))) *
          1000,
      scopes: unique(
        (stringField(response, 'scope') || stored.scopes.join(' ')).split(/\s+/).filter(Boolean),
      ),
    };
    await native.credentialStore.set(account, JSON.stringify(updated));
    return updated.accessToken;
  });
}

async function fetchUserIdentity(
  client: Client,
  accessToken: string,
): Promise<{ openId: string; name: string }> {
  const response = await client.request<{
    code?: number;
    msg?: string;
    data?: { open_id?: string; name?: string };
  }>({ method: 'GET', url: '/open-apis/authen/v1/user_info' }, withUserAccessToken(accessToken));
  assertApiResponse(response, '获取授权用户信息失败');
  const openId = response.data?.open_id;
  if (!openId) throw new Error('获取授权用户信息失败：响应缺少 open_id');
  return { openId, name: response.data?.name || '(unknown)' };
}

async function readMetadata(path: string): Promise<UserMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<UserMetadata>;
    if (
      value.version !== 1 ||
      typeof value.appId !== 'string' ||
      typeof value.openId !== 'string' ||
      typeof value.userName !== 'string' ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope) => typeof scope === 'string')
    ) {
      return undefined;
    }
    return value as UserMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseStoredToken(raw: string | undefined): StoredToken | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredToken>;
    if (
      value.version !== 1 ||
      typeof value.appId !== 'string' ||
      typeof value.openId !== 'string' ||
      typeof value.accessToken !== 'string' ||
      typeof value.refreshToken !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      typeof value.refreshExpiresAt !== 'number' ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope) => typeof scope === 'string')
    ) {
      return undefined;
    }
    return value as StoredToken;
  } catch {
    return undefined;
  }
}

function oauthEndpoints(tenant: TenantBrand) {
  const accounts =
    tenant === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';
  const open = tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return {
    deviceAuthorization: `${accounts}/oauth/v1/device_authorization`,
    token: `${open}/open-apis/authen/v2/oauth/token`,
    revoke: `${accounts}/oauth/v1/revoke`,
  };
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Lark OAuth HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok && !body.error) {
    throw new Error(`Lark OAuth HTTP ${response.status}`);
  }
  return body;
}

function chatPage(
  data:
    | {
        items?: Array<{ chat_id?: string; name?: string }>;
        has_more?: boolean;
        page_token?: string;
      }
    | undefined,
): UserChatsPage {
  return {
    chats: (data?.items ?? [])
      .filter((item): item is { chat_id: string; name?: string } => Boolean(item.chat_id))
      .map((item) => ({ id: item.chat_id, name: item.name?.trim() || '(无名群)' })),
    ...(data?.has_more && data.page_token ? { nextPageToken: data.page_token } : {}),
  };
}

function assertApiResponse(response: { code?: number; msg?: string }, prefix: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${prefix}：${response.msg ?? response.code}`);
  }
}

function isTerminalRefreshFailure(response: Record<string, unknown>): boolean {
  const code = numberField(response, 'code');
  return code !== undefined && code !== 0 && ![99991400, 99991401, 99991402].includes(code);
}

function oauthError(response: Record<string, unknown>, fallback: string): string {
  return (
    stringField(response, 'error_description') ||
    stringField(response, 'msg') ||
    stringField(response, 'error') ||
    fallback
  );
}

function tokenAccount(appId: string, openId: string): string {
  return `${appId}:${openId}`;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

class UserAuthorizationRequired extends Error {
  constructor(message = '当前 profile 没有可用的用户身份授权') {
    super(message);
    this.name = 'UserAuthorizationRequired';
  }
}
