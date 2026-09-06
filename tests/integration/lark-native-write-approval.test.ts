import type { LarkChannel } from '@larksuite/channel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import type { CallbackAuth } from '../../src/card/callback-auth';
import type { ProfileConfig } from '../../src/config/profile-schema';
import { NativeLarkServer, nativeApprovalAction } from '../../src/lark-native/server';

const userIdentity = vi.hoisted(() => ({
  addBotToChat: vi.fn(async () => ({ ok: true, pending: false })),
  logoutUser: vi.fn(async () => {}),
}));

vi.mock('../../src/lark-native/user-im', () => ({
  ADD_BOT_SCOPES: ['im:chat.members:write_only'],
  addBotToChat: userIdentity.addBotToChat,
  completeDeviceLogin: vi.fn(),
  getUserAuthStatus: vi.fn(async () => ({
    loggedIn: true,
    openId: 'ou_user',
    scopes: ['im:chat.members:write_only'],
  })),
  listUserChats: vi.fn(),
  logoutUser: userIdentity.logoutUser,
  searchUserChats: vi.fn(),
  startDeviceLogin: vi.fn(),
}));

describe('native Lark write approval', () => {
  it('blocks the write until the signed approval action matches run, scope, and actor', async () => {
    const send = vi.fn(
      async (_recipientId: string, _content: { card: object }, _options: object) => ({
        messageId: 'om_approval',
      }),
    );
    const channel = {
      rawClient: { appId: 'cli_bot' },
      send,
    } as unknown as LarkChannel;
    const callbackAuth = {
      sign: vi.fn(({ action }: { action: string }) => `signed:${action}`),
    } as unknown as CallbackAuth;
    const server = await NativeLarkServer.start({
      profile: 'default',
      channel,
      callbackAuth,
      profileConfig: () => ({ mode: 'personal' }) as ProfileConfig,
    });
    const endpoint = server.openRun({
      runId: 'run-write',
      cwd: process.cwd(),
      scopeId: 'p2p:oc_current:ou_user',
      scope: {
        source: 'im',
        chatId: 'oc_current',
        chatType: 'p2p',
        messageId: 'om_source',
        actorId: 'ou_user',
      },
      policyFingerprint: 'fp-write',
      allowUserIdentity: true,
    });
    const client = new Client({ name: 'write-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.bearerToken}` } },
    });

    try {
      await client.connect(transport);
      const resultPromise = client.callTool({
        name: 'lark_add_bot_to_chat',
        arguments: { chatId: 'oc_target' },
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(userIdentity.addBotToChat).not.toHaveBeenCalled();

      const sent = send.mock.calls[0];
      if (!sent) throw new Error('approval card was not sent');
      const approveValue = findApprovalValue(sent[1].card);
      if (!approveValue) throw new Error('approval callback was not found');
      const approval = nativeApprovalAction(approveValue);
      if (!approval) throw new Error('approval callback was invalid');
      expect(approval).toMatchObject({ decision: 'approve' });
      expect(approveValue.bridge_token).toBe(`signed:${approval.action}`);
      expect(
        server.resolveApproval({
          id: approval.id,
          decision: 'approve',
          scopeId: 'p2p:oc_current:ou_user',
          actorId: 'ou_other',
        }),
      ).toBe(false);
      expect(
        server.resolveApproval({
          id: approval.id,
          decision: 'approve',
          scopeId: 'p2p:oc_current:ou_user',
          actorId: 'ou_user',
        }),
      ).toBe(true);

      expect(await resultPromise).toMatchObject({
        structuredContent: { ok: true, pending: false },
      });
      expect(userIdentity.addBotToChat).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'default' }),
        'oc_target',
        'cli_bot',
      );

      const logoutPromise = client.callTool({
        name: 'lark_user_auth_logout',
        arguments: {},
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const logoutSent = send.mock.calls[1];
      if (!logoutSent) throw new Error('logout approval card was not sent');
      const logoutValue = findApprovalValue(logoutSent[1].card);
      if (!logoutValue) throw new Error('logout approval callback was not found');
      const logoutApproval = nativeApprovalAction(logoutValue);
      if (!logoutApproval) throw new Error('logout approval callback was invalid');
      expect(
        server.resolveApproval({
          id: logoutApproval.id,
          decision: 'approve',
          scopeId: 'p2p:oc_current:ou_user',
          actorId: 'ou_user',
        }),
      ).toBe(true);
      expect(await logoutPromise).toMatchObject({ structuredContent: { ok: true } });
      expect(userIdentity.logoutUser).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'default' }),
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });
});

function findApprovalValue(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApprovalValue(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.__bridge_approval === true) return record;
  for (const item of Object.values(record)) {
    const found = findApprovalValue(item);
    if (found) return found;
  }
  return undefined;
}
