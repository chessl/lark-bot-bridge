import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { saveRootConfig } from '../../../src/config/profile-store';
import type { CredentialStore } from '../../../src/lark-native/keychain';
import {
  addBotToChat,
  completeDeviceLogin,
  getUserAuthStatus,
  listUserChats,
  logoutUser,
  searchUserChats,
  startDeviceLogin,
} from '../../../src/lark-native/user-im';

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async remove(account: string): Promise<void> {
    this.values.delete(account);
  }
}

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native user identity', () => {
  it('authorizes, persists, refreshes, and uses a user token for IM calls', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lark-native-user-'));
    roots.push(rootDir);
    await saveRootConfig(
      {
        schemaVersion: 2,
        activeProfile: 'default',
        profiles: {
          default: createDefaultProfileConfig({
            app: { id: 'cli_test', secret: 'app-secret', tenant: 'feishu' },
          }),
        },
      },
      join(rootDir, 'config.json'),
    );

    const list = vi.fn(async (_payload: unknown, _options?: unknown) => ({
      code: 0,
      data: {
        items: [
          { chat_id: 'oc_1', name: '产品群' },
          { chat_id: 'oc_2', name: '' },
        ],
        has_more: true,
        page_token: 'next',
      },
    }));
    const search = vi.fn(async (_payload: unknown, _options?: unknown) => ({
      code: 0,
      data: { items: [{ chat_id: 'oc_1', name: '产品群' }] },
    }));
    const addMember = vi.fn(async (_payload: unknown, _options?: unknown) => ({
      code: 0,
      data: {},
    }));
    const client = {
      request: vi.fn(async () => ({
        code: 0,
        data: { open_id: 'ou_user', name: '测试用户' },
      })),
      im: {
        v1: {
          chat: { list, search },
          chatMembers: { create: addMember },
        },
      },
    } as unknown as Client;
    const credentials = new MemoryCredentials();
    const ctx = { profile: 'default', rootDir, client, credentialStore: credentials };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'device-1',
          user_code: 'ABCD',
          verification_uri_complete: 'https://open.feishu.cn/verify?code=ABCD',
          expires_in: 300,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'uat-1',
          refresh_token: 'refresh-1',
          expires_in: 7200,
          refresh_token_expires_in: 2_592_000,
          scope: 'offline_access im:chat:read im:chat.members:write_only',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await getUserAuthStatus(ctx)).toEqual({ loggedIn: false, scopes: [] });
    const login = await startDeviceLogin(ctx, [
      'im:chat:read',
      'im:chat.members:write_only',
      'im:chat:read',
    ]);
    expect(login).toEqual({
      verificationUrl: 'https://open.feishu.cn/verify?code=ABCD',
      deviceCode: 'device-1',
      userCode: 'ABCD',
      expiresIn: 300,
    });
    const startRequest = fetchMock.mock.calls[0];
    expect(startRequest?.[0]).toBe('https://accounts.feishu.cn/oauth/v1/device_authorization');
    expect(String(startRequest?.[1]?.body)).toContain(
      'scope=im%3Achat.members%3Awrite_only+im%3Achat%3Aread+offline_access',
    );

    expect(await completeDeviceLogin(ctx, login.deviceCode)).toEqual({ ok: true });
    expect(await getUserAuthStatus(ctx)).toEqual({
      loggedIn: true,
      userName: '测试用户',
      openId: 'ou_user',
      scopes: ['im:chat.members:write_only', 'im:chat:read', 'offline_access'],
    });

    expect(await listUserChats(ctx, { pageSize: 8 })).toEqual({
      chats: [
        { id: 'oc_1', name: '产品群' },
        { id: 'oc_2', name: '(无名群)' },
      ],
      nextPageToken: 'next',
    });
    expect(await searchUserChats(ctx, { query: '产品' })).toEqual({
      chats: [{ id: 'oc_1', name: '产品群' }],
    });
    expect(await addBotToChat(ctx, 'oc_1', 'cli_test')).toEqual({ ok: true, pending: false });
    expect(list.mock.calls[0]?.[1]).toBeDefined();
    expect(search.mock.calls[0]?.[1]).toBeDefined();
    expect(addMember.mock.calls[0]?.[0]).toEqual({
      path: { chat_id: 'oc_1' },
      params: { member_id_type: 'app_id' },
      data: { id_list: ['cli_test'] },
    });
    expect(addMember.mock.calls[0]?.[1]).toBeDefined();

    const account = 'cli_test:ou_user';
    const stored = JSON.parse(credentials.values.get(account) ?? '{}') as Record<string, unknown>;
    stored.expiresAt = Date.now() - 1;
    credentials.values.set(account, JSON.stringify(stored));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        access_token: 'uat-2',
        refresh_token: 'refresh-2',
        expires_in: 7200,
        refresh_token_expires_in: 2_592_000,
      }),
    );

    await listUserChats(ctx);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    );
    expect(JSON.parse(credentials.values.get(account) ?? '{}')).toMatchObject({
      accessToken: 'uat-2',
      refreshToken: 'refresh-2',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await logoutUser(ctx);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://accounts.feishu.cn/oauth/v1/revoke');
    expect(String(fetchMock.mock.calls[3]?.[1]?.body)).toContain(
      'client_id=cli_test&client_secret=app-secret&token=uat-2&token_type_hint=access_token',
    );
    expect(credentials.values.has(account)).toBe(false);
    expect(await getUserAuthStatus(ctx)).toEqual({ loggedIn: false, scopes: [] });
  });
});

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
