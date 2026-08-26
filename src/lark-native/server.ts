import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  NativeMcpEndpoint,
  NativeToolProvider,
  NativeToolRunContext,
} from '../agent/native-tools';
import type { CallbackAuth } from '../card/callback-auth';
import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { downloadLarkResourceToFile } from '../media/cache';
import {
  ADD_BOT_SCOPES,
  addBotToChat,
  completeDeviceLogin,
  getUserAuthStatus,
  listUserChats,
  logoutUser,
  searchUserChats,
  startDeviceLogin,
} from './user-im';

const HOST = '127.0.0.1';
const BODY_LIMIT = 1024 * 1024;
const APPROVAL_TIMEOUT_MS = 2 * 60_000;
const CALLBACK_TTL_MS = 24 * 60 * 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface NativeLarkServerOptions {
  profile: string;
  rootDir?: string;
  channel: LarkChannel;
  callbackAuth?: CallbackAuth;
  profileConfig: () => ProfileConfig;
}

interface SessionEntry {
  runId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface PendingApproval {
  runId: string;
  scopeId: string;
  actorId: string;
  finish(approved: boolean): void;
}

export class NativeLarkServer implements NativeToolProvider {
  private readonly runsByToken = new Map<string, NativeToolRunContext>();
  private readonly tokensByRun = new Map<string, string>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly approvals = new Map<string, PendingApproval>();
  private port = 0;

  private constructor(
    private readonly options: NativeLarkServerOptions,
    private readonly httpServer: Server,
  ) {}

  static async start(options: NativeLarkServerOptions): Promise<NativeLarkServer> {
    let instance: NativeLarkServer;
    const httpServer = createServer((request, response) => {
      void instance.handleRequest(request, response).catch((error) => {
        log.warn('native-mcp', 'request-failed', { err: errorMessage(error) });
        if (!response.headersSent) sendJson(response, 500, rpcError(-32603, 'Internal error'));
        else response.end();
      });
    });
    instance = new NativeLarkServer(options, httpServer);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    httpServer.once('error', reject);
    httpServer.listen(0, HOST, resolve);
    await promise;
    instance.port = (httpServer.address() as AddressInfo).port;
    log.info('native-mcp', 'listening', {
      profile: options.profile,
      host: HOST,
      port: instance.port,
    });
    return instance;
  }

  openRun(context: NativeToolRunContext): NativeMcpEndpoint {
    const token = randomBytes(32).toString('base64url');
    this.runsByToken.set(token, context);
    this.tokensByRun.set(context.runId, token);
    return {
      name: 'lark_bridge',
      url: `http://${HOST}:${this.port}/mcp`,
      bearerToken: token,
    };
  }

  async closeRun(runId: string): Promise<void> {
    const token = this.tokensByRun.get(runId);
    if (token) this.runsByToken.delete(token);
    this.tokensByRun.delete(runId);
    for (const pending of this.approvals.values()) {
      if (pending.runId === runId) pending.finish(false);
    }
    const closing: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.runId !== runId) continue;
      this.sessions.delete(sessionId);
      closing.push(session.server.close());
    }
    await Promise.allSettled(closing);
  }

  resolveApproval(input: {
    id: string;
    decision: 'approve' | 'deny';
    scopeId: string;
    actorId: string;
  }): boolean {
    const pending = this.approvals.get(input.id);
    if (!pending || pending.scopeId !== input.scopeId || pending.actorId !== input.actorId)
      return false;
    pending.finish(input.decision === 'approve');
    return true;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tokensByRun.keys()].map((runId) => this.closeRun(runId)));
    const { promise, resolve } = Promise.withResolvers<void>();
    this.httpServer.close(() => resolve());
    await promise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, rpcError(-32001, 'Forbidden'));
      return;
    }
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    if (url.pathname !== '/mcp') {
      sendJson(response, 404, rpcError(-32004, 'Not found'));
      return;
    }
    const access = this.authenticate(request);
    if (!access) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(response, 401, rpcError(-32001, 'Unauthorized'));
      return;
    }
    const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
    const sessionId = header(request, 'mcp-session-id');
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session && session.runId !== access.runId) session = undefined;

    if (!session && !sessionId && request.method === 'POST' && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, { runId: access.runId, server, transport });
        },
      });
      const server = this.createProtocolServer(access);
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) this.sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    if (!session) {
      sendJson(response, 400, rpcError(-32000, 'No valid MCP session'));
      return;
    }
    await session.transport.handleRequest(request, response, body);
  }

  private authenticate(request: IncomingMessage): NativeToolRunContext | undefined {
    const authorization = header(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return this.runsByToken.get(authorization.slice('Bearer '.length));
  }

  private createProtocolServer(access: NativeToolRunContext): McpServer {
    const server = new McpServer({ name: 'lark-bot-bridge', version: '1.0.0' });
    server.registerTool(
      'lark_list_chats',
      {
        description: 'List groups visible to the current bot or authorized user.',
        inputSchema: {
          identity: z.enum(['bot', 'user']).default('bot'),
          pageSize: z.number().int().min(1).max(100).default(20),
          pageToken: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ identity, pageSize, pageToken }) =>
        this.toolResult(async () => {
          if (identity === 'user') {
            this.requireUserIdentity(access);
            return listUserChats(this.userContext(), { pageSize, pageToken });
          }
          const response = await this.options.channel.rawClient.im.v1.chat.list({
            params: {
              sort_type: 'ByActiveTimeDesc',
              page_size: pageSize,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          assertApiResponse(response, 'List chats failed');
          return response.data ?? {};
        }),
    );
    server.registerTool(
      'lark_search_chats',
      {
        description: 'Search groups visible to the current bot or authorized user.',
        inputSchema: {
          query: z.string().min(1).max(128),
          identity: z.enum(['bot', 'user']).default('bot'),
          pageSize: z.number().int().min(1).max(100).default(20),
          pageToken: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, identity, pageSize, pageToken }) =>
        this.toolResult(async () => {
          if (identity === 'user') {
            this.requireUserIdentity(access);
            return searchUserChats(this.userContext(), { query, pageSize, pageToken });
          }
          const response = await this.options.channel.rawClient.im.v1.chat.search({
            params: {
              query,
              page_size: pageSize,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          assertApiResponse(response, 'Search chats failed');
          return response.data ?? {};
        }),
    );
    server.registerTool(
      'lark_get_chat',
      {
        description: 'Get one chat visible to the current bot.',
        inputSchema: { chatId: z.string().min(1).max(128) },
        annotations: { readOnlyHint: true },
      },
      async ({ chatId }) =>
        this.toolResult(async () => {
          const response = await this.options.channel.rawClient.im.v1.chat.get({
            path: { chat_id: chatId },
          });
          assertApiResponse(response, 'Get chat failed');
          return response.data ?? {};
        }),
    );
    server.registerTool(
      'lark_list_messages',
      {
        description:
          'List messages from the current chat/thread or an explicit visible container. Thread containers accept either an omt_ thread ID or an om_ message ID, which is resolved automatically.',
        inputSchema: {
          containerId: z.string().min(1).max(128).optional(),
          containerType: z.enum(['chat', 'thread']).optional(),
          pageSize: z.number().int().min(1).max(50).default(20),
          pageToken: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ containerId, containerType, pageSize, pageToken }) =>
        this.toolResult(async () => {
          const inferredType = containerType ?? (access.scope.threadId ? 'thread' : 'chat');
          let inferredId =
            containerId ??
            (inferredType === 'thread' ? access.scope.threadId : access.scope.chatId);
          if (!inferredId) throw new Error('Current run is not attached to an IM container');
          if (inferredType === 'thread' && inferredId.startsWith('om_')) {
            const [message] = await this.options.channel.fetchRawMessage(inferredId);
            const threadId = messageThreadId(message);
            if (!threadId) throw new Error(`Message ${inferredId} is not part of a thread`);
            inferredId = threadId;
          }
          if (inferredType === 'thread' && !inferredId.startsWith('omt_')) {
            throw new Error('Thread container ID must start with omt_ or om_');
          }
          if (inferredType === 'chat' && !inferredId.startsWith('oc_')) {
            throw new Error('Chat container ID must start with oc_');
          }
          const response = await this.options.channel.rawClient.im.v1.message.list({
            params: {
              container_id_type: inferredType,
              container_id: inferredId,
              sort_type: 'ByCreateTimeDesc',
              page_size: pageSize,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          assertApiResponse(response, 'List messages failed');
          return response.data ?? {};
        }),
    );
    server.registerTool(
      'lark_download_message_resource',
      {
        description:
          'Download any attachment from a listed Lark message into this run workspace. Use message_id and file_key from lark_list_messages; file_name is optional.',
        inputSchema: {
          messageId: z.string().min(1).max(128),
          fileKey: z.string().min(1).max(1024),
          fileName: z.string().min(1).max(180).optional(),
          resourceType: z.enum(['image', 'file', 'audio', 'video', 'sticker']).default('file'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ messageId, fileKey, fileName, resourceType }) =>
        this.toolResult(async () => {
          const directory = join(access.cwd, '.lark-downloads');
          await mkdir(directory, { recursive: true });
          const name = safeFileName(fileName ?? defaultResourceFileName(resourceType));
          const path = join(directory, `${randomUUID()}-${name}`);
          const result = await downloadLarkResourceToFile(
            this.options.channel,
            {
              messageId,
              resource: { type: resourceType, fileKey, ...(fileName ? { fileName } : {}) },
            },
            path,
          );
          return { path, ...result };
        }),
    );
    server.registerTool(
      'lark_get_document_blocks',
      {
        description: 'Read one page of blocks from a visible Docx document.',
        inputSchema: {
          documentId: z.string().min(1).max(128),
          pageSize: z.number().int().min(1).max(500).default(100),
          pageToken: z.string().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ documentId, pageSize, pageToken }) =>
        this.toolResult(async () => {
          const response = await this.options.channel.rawClient.request<{
            code?: number;
            msg?: string;
            data?: unknown;
          }>({
            method: 'GET',
            url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
            params: {
              document_revision_id: -1,
              page_size: pageSize,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          assertApiResponse(response, 'Read document failed');
          return response.data ?? {};
        }),
    );
    server.registerTool(
      'lark_user_auth_status',
      {
        description: 'Check whether this profile has an authorized Lark user identity.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () =>
        this.toolResult(async () => {
          this.requireUserIdentity(access);
          return getUserAuthStatus(this.userContext());
        }),
    );
    server.registerTool(
      'lark_user_auth_start',
      {
        description: 'Start user OAuth in a private chat. Returns the URL the user must open.',
        inputSchema: { includeAddBotPermission: z.boolean().default(false) },
        annotations: { readOnlyHint: true },
      },
      async ({ includeAddBotPermission }) =>
        this.toolResult(async () => {
          this.requireUserIdentity(access);
          return startDeviceLogin(
            this.userContext(),
            includeAddBotPermission ? ['im:chat:read', ...ADD_BOT_SCOPES] : ['im:chat:read'],
          );
        }),
    );
    server.registerTool(
      'lark_user_auth_complete',
      {
        description: 'Complete a previously started Lark user OAuth device flow.',
        inputSchema: { deviceCode: z.string().min(1).max(1024) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ deviceCode }) =>
        this.toolResult(async () => {
          this.requireUserIdentity(access);
          return completeDeviceLogin(this.userContext(), deviceCode);
        }),
    );
    server.registerTool(
      'lark_user_auth_logout',
      {
        description: 'Revoke and remove the profile user identity after Lark confirmation.',
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async (_args, { signal }) =>
        this.toolResult(async () => {
          this.requireUserIdentity(access);
          const approved = await this.requestApproval(
            access,
            '撤销当前 profile 的用户身份授权',
            signal,
          );
          if (!approved) return { ok: false, denied: true };
          await logoutUser(this.userContext());
          return { ok: true };
        }),
    );
    server.registerTool(
      'lark_send_card',
      {
        description:
          'Send a CardKit card to the current conversation. Mark callback values with __bridge_cb=true; the bridge signs them.',
        inputSchema: { card: z.record(z.string(), z.unknown()) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ card }) =>
        this.toolResult(async () => {
          const chatId = access.scope.chatId;
          if (!chatId) throw new Error('Current run is not attached to an IM chat');
          const signed = this.signAgentCallbacks(card, access) as object;
          const result = await this.options.channel.send(
            chatId,
            { card: signed },
            {
              ...(access.scope.messageId ? { replyTo: access.scope.messageId } : {}),
              ...(access.scope.threadId && access.scope.messageId ? { replyInThread: true } : {}),
            },
          );
          return { messageId: result.messageId };
        }),
    );
    server.registerTool(
      'lark_send_image',
      {
        description:
          'Upload and send an agent-created image from the run workspace to the current conversation.',
        inputSchema: {
          path: z.string().min(1).max(4096).describe('Absolute or workspace-relative image path.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ path }) =>
        this.toolResult(async () => {
          const chatId = access.scope.chatId;
          if (!chatId) throw new Error('Current run is not attached to an IM chat');
          const imagePath = await workspaceImagePath(access.cwd, path);
          const result = await this.options.channel.send(
            chatId,
            { image: { source: imagePath } },
            {
              ...(access.scope.messageId ? { replyTo: access.scope.messageId } : {}),
              ...(access.scope.threadId && access.scope.messageId ? { replyInThread: true } : {}),
            },
          );
          return { messageId: result.messageId };
        }),
    );
    server.registerTool(
      'lark_add_bot_to_chat',
      {
        description:
          'Add this bridge bot to a group using the authorized user identity. Always asks the user to approve in Lark before writing.',
        inputSchema: { chatId: z.string().min(1).max(128) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ chatId }, { signal }) =>
        this.toolResult(async () => {
          this.requireUserIdentity(access);
          const status = await getUserAuthStatus(this.userContext());
          if (!status.loggedIn || !ADD_BOT_SCOPES.some((scope) => status.scopes.includes(scope))) {
            return {
              ok: false,
              needAuth: true,
              message: '拉 bot 进群需要用户身份的 im:chat.members:write_only 授权',
            };
          }
          const approved = await this.requestApproval(
            access,
            `把当前 bridge bot 加入群聊 \`${escapeMarkdown(chatId)}\``,
            signal,
          );
          if (!approved) return { ok: false, denied: true, message: '用户拒绝、取消或确认超时' };
          return addBotToChat(this.userContext(), chatId, this.options.channel.rawClient.appId);
        }),
    );
    return server;
  }

  private userContext() {
    return {
      profile: this.options.profile,
      rootDir: this.options.rootDir,
      client: this.options.channel.rawClient,
    };
  }

  private requireUserIdentity(access: NativeToolRunContext): void {
    if (
      !access.allowUserIdentity ||
      access.scope.source !== 'im' ||
      access.scope.chatType !== 'p2p' ||
      this.options.profileConfig().mode !== 'personal'
    ) {
      throw new Error('User identity is allowed only for a personal profile in a private chat');
    }
  }

  private signAgentCallbacks(value: unknown, access: NativeToolRunContext): unknown {
    if (Array.isArray(value)) return value.map((item) => this.signAgentCallbacks(item, access));
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const mapped = Object.fromEntries(
      Object.entries(source).map(([key, item]) => [key, this.signAgentCallbacks(item, access)]),
    );
    if (source.__bridge_cb !== true) return mapped;
    const callbackAuth = this.options.callbackAuth;
    const chatId = access.scope.chatId;
    if (!callbackAuth || !chatId) throw new Error('Signed card callbacks are unavailable');
    return {
      ...mapped,
      bridge_token: callbackAuth.sign({
        runId: access.runId,
        scope: access.scopeId,
        chatId,
        operatorOpenId: access.scope.actorId,
        action: 'agent_callback',
        policyFingerprint: access.policyFingerprint,
        ttlMs: CALLBACK_TTL_MS,
      }),
    };
  }

  private async requestApproval(
    access: NativeToolRunContext,
    summary: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const callbackAuth = this.options.callbackAuth;
    const chatId = access.scope.chatId;
    if (!callbackAuth || !chatId) throw new Error('Write approval is unavailable');
    if (signal.aborted) return false;
    const id = randomUUID();
    const action = (decision: 'approve' | 'deny') => `native_write:${decision}:${id}`;
    const token = (decision: 'approve' | 'deny') =>
      callbackAuth.sign({
        runId: access.runId,
        scope: access.scopeId,
        chatId,
        operatorOpenId: access.scope.actorId,
        action: action(decision),
        policyFingerprint: access.policyFingerprint,
        ttlMs: APPROVAL_TIMEOUT_MS,
      });
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.approvals.delete(id);
      resolve(approved);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    this.approvals.set(id, {
      runId: access.runId,
      scopeId: access.scopeId,
      actorId: access.scope.actorId,
      finish,
    });
    try {
      await this.options.channel.send(
        chatId,
        { card: approvalCard(summary, id, token('approve'), token('deny')) },
        {
          ...(access.scope.messageId ? { replyTo: access.scope.messageId } : {}),
          ...(access.scope.threadId && access.scope.messageId ? { replyInThread: true } : {}),
        },
      );
    } catch (error) {
      finish(false);
      throw error;
    }
    return promise;
  }

  private async toolResult(fn: () => Promise<unknown>) {
    try {
      const result = await fn();
      const structuredContent = asObject(result);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        ...(structuredContent ? { structuredContent } : {}),
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: errorMessage(error) }],
      };
    }
  }
}

export function nativeApprovalAction(
  payload: Record<string, unknown>,
): { id: string; decision: 'approve' | 'deny'; action: string } | undefined {
  if (payload.__bridge_approval !== true) return undefined;
  const id = typeof payload.approval_id === 'string' ? payload.approval_id : '';
  const decision =
    payload.decision === 'approve' || payload.decision === 'deny' ? payload.decision : '';
  if (!id || !decision) return undefined;
  return { id, decision, action: `native_write:${decision}:${id}` };
}

function approvalCard(
  summary: string,
  id: string,
  approveToken: string,
  denyToken: string,
): object {
  const button = (
    text: string,
    decision: 'approve' | 'deny',
    bridgeToken: string,
    type: string,
  ) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [
      {
        type: 'callback',
        value: {
          __bridge_approval: true,
          approval_id: id,
          decision,
          bridge_token: bridgeToken,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '确认 Lark 写操作' },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `${summary}\n\n仅发起请求的用户可以确认，2 分钟后失效。` },
        {
          tag: 'action',
          actions: [
            button('允许', 'approve', approveToken, 'primary'),
            button('拒绝', 'deny', denyToken, 'default'),
          ],
        },
      ],
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new Error('MCP request body too large');
    chunks.push(bytes);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function assertApiResponse(response: { code?: number; msg?: string }, prefix: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${prefix}: ${response.msg ?? response.code}`);
  }
}

async function workspaceImagePath(cwd: string, input: string): Promise<string> {
  const image = await realpath(resolve(cwd, input));
  const relativePath = relative(cwd, image);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Image must be inside the run workspace');
  }
  const info = await stat(image);
  if (!info.isFile()) throw new Error('Image path must point to a file');
  if (info.size === 0) throw new Error('Image file is empty');
  if (info.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB Lark limit');
  return image;
}

function defaultResourceFileName(type: 'image' | 'file' | 'audio' | 'video' | 'sticker'): string {
  switch (type) {
    case 'image':
      return 'image.png';
    case 'audio':
      return 'audio.ogg';
    case 'video':
      return 'video.mp4';
    default:
      return 'attachment.bin';
  }
}

function safeFileName(input: string): string {
  const name = basename(input.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '..') throw new Error('Invalid attachment file name');
  return name;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[`\\]/g, '\\$&');
}

function messageThreadId(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('thread_id' in message)) return undefined;
  return typeof message.thread_id === 'string' && message.thread_id.startsWith('omt_')
    ? message.thread_id
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
