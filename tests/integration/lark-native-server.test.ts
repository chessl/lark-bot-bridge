import type { LarkChannel } from '@larksuite/channel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import type { CallbackAuth } from '../../src/card/callback-auth';
import type { ProfileConfig } from '../../src/config/profile-schema';
import { NativeLarkServer } from '../../src/lark-native/server';

describe('NativeLarkServer', () => {
  it('authenticates one run and exposes native Lark reads and signed card sends', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_sent' }));
    const getChat = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_current' } }));
    const listMessages = vi.fn(async () => ({
      code: 0,
      data: { items: [{ message_id: 'om_1' }] },
    }));
    const readDocument = vi.fn(async () => ({
      code: 0,
      data: { items: [{ block_id: 'doc_1', block_type: 1 }] },
    }));
    const channel = {
      rawClient: {
        im: {
          v1: {
            chat: { get: getChat },
            message: { list: listMessages },
          },
        },
        request: readDocument,
      },
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
      runId: 'run-1',
      scopeId: 'p2p:oc_current:ou_user',
      scope: {
        source: 'im',
        chatId: 'oc_current',
        chatType: 'p2p',
        messageId: 'om_source',
        actorId: 'ou_user',
      },
      policyFingerprint: 'fp-1',
      allowUserIdentity: true,
    });

    try {
      expect((await fetch(endpoint.url, { method: 'POST' })).status).toBe(401);

      const client = new Client({ name: 'native-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.bearerToken}` } },
      });
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'lark_list_chats',
          'lark_search_chats',
          'lark_get_chat',
          'lark_list_messages',
          'lark_get_document_blocks',
          'lark_user_auth_logout',
          'lark_user_auth_status',
          'lark_send_card',
          'lark_add_bot_to_chat',
        ]),
      );

      expect(
        await client.callTool({ name: 'lark_get_chat', arguments: { chatId: 'oc_current' } }),
      ).toMatchObject({ structuredContent: { chat_id: 'oc_current' } });
      expect(
        await client.callTool({ name: 'lark_list_messages', arguments: { pageSize: 10 } }),
      ).toMatchObject({ structuredContent: { items: [{ message_id: 'om_1' }] } });
      expect(listMessages).toHaveBeenCalledWith({
        params: {
          container_id_type: 'chat',
          container_id: 'oc_current',
          sort_type: 'ByCreateTimeDesc',
          page_size: 10,
        },
      });
      expect(
        await client.callTool({
          name: 'lark_get_document_blocks',
          arguments: { documentId: 'doc_1', pageSize: 50 },
        }),
      ).toMatchObject({
        structuredContent: { items: [{ block_id: 'doc_1', block_type: 1 }] },
      });
      expect(readDocument).toHaveBeenCalledWith({
        method: 'GET',
        url: '/open-apis/docx/v1/documents/doc_1/blocks',
        params: { document_revision_id: -1, page_size: 50 },
      });

      await client.callTool({
        name: 'lark_send_card',
        arguments: {
          card: {
            schema: '2.0',
            body: {
              elements: [
                {
                  tag: 'button',
                  behaviors: [{ type: 'callback', value: { __bridge_cb: true, choice: 'yes' } }],
                },
              ],
            },
          },
        },
      });
      expect(send).toHaveBeenCalledWith(
        'oc_current',
        expect.objectContaining({
          card: expect.objectContaining({
            body: expect.objectContaining({
              elements: [
                expect.objectContaining({
                  behaviors: [
                    expect.objectContaining({
                      value: expect.objectContaining({
                        choice: 'yes',
                        bridge_token: 'signed:agent_callback',
                      }),
                    }),
                  ],
                }),
              ],
            }),
          }),
        }),
        { replyTo: 'om_source' },
      );

      await client.close();
      await server.closeRun('run-1');
      expect(
        (
          await fetch(endpoint.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${endpoint.bearerToken}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await server.close();
    }
  });
});
