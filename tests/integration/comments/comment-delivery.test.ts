import type { CommentEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { makeFakeCommentSurface } from '../../helpers/fake-comment-surface.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RequestRecord {
  method: string;
  url: string;
  data?: unknown;
}

interface FakeCommentChannel {
  requests: RequestRecord[];
  comments: ReturnType<typeof makeFakeCommentSurface>;
  rawClient: {
    request(input: { method: string; url: string; data?: unknown }): Promise<unknown>;
    wiki: { v2: { space: { getNode(input: unknown): Promise<unknown> } } };
    drive: {
      v1: {
        fileComment: {
          get(input: unknown): Promise<unknown>;
          list(input: unknown): Promise<unknown>;
          create(input: unknown): Promise<unknown>;
        };
      };
    };
  };
}

const cleanups: Array<() => Promise<void>> = [];

describe('cloud-doc comment delivery', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resolves wiki nodes, reads comment.get, strips markdown, and truncates replies to 2000 chars', async () => {
    const h = await createCommentHarness({
      wikiNode: { obj_token: 'doc-token', obj_type: 'docx' },
      getResponse: commentGet({
        replyId: 'reply-1',
        question: '@bot **Please** inspect `this`',
        quote: 'selected text',
        isWhole: false,
      }),
      agentText: `# ${'x'.repeat(2_100)}`,
    });

    await handleCommentMention(h.deps(event({ fileToken: 'wiki-token', fileType: 'docx' })));

    const reply = h.inThreadReplies.at(-1);
    expect(reply).toBeDefined();
    expect(reply).toHaveLength(2_000);
    expect(reply?.endsWith('…')).toBe(true);
    expect(h.agent.runOptions[0]?.prompt).toContain('file_token：doc-token');
    expect(h.agent.runOptions[0]?.prompt).toContain(
      'lark_get_document_blocks 读取 document_id doc-token',
    );
    expect(h.agent.runOptions[0]?.prompt).toContain('用户选中的原文');
    expect(h.reactionActions()).toEqual(['add', 'delete']);
  });

  it('falls back from comment.get to paginated comment.list', async () => {
    const h = await createCommentHarness({
      getErrorCode: 1069307,
      listResponses: [
        {
          data: {
            items: [{ comment_id: 'other', reply_list: { replies: [] } }],
            has_more: true,
            page_token: 'page-2',
          },
        },
        {
          data: {
            items: [
              commentListItem({
                commentId: 'comment-1',
                replyId: 'reply-2',
                question: 'list question',
                quote: 'list quote',
                isWhole: false,
              }),
            ],
          },
        },
      ],
      agentText: 'plain answer',
    });

    await handleCommentMention(h.deps(event({ replyId: 'reply-2' })));

    expect(h.listCalls).toBe(2);
    expect(h.inThreadReplies.at(-1)).toBe('plain answer');
    expect(h.agent.runOptions[0]?.prompt).toContain('用户的问题：list question');
  });

  it('posts whole-document comments as top-level replies without an in-thread probe', async () => {
    const h = await createCommentHarness({
      getResponse: commentGet({
        replyId: 'reply-3',
        question: 'whole doc question',
        isWhole: true,
      }),
      agentText: '**bold** _italic_ `code`\n- item\n> quote',
    });

    await handleCommentMention(h.deps(event({ replyId: 'reply-3' })));

    // The comment is known to be whole-document, so the bridge passes
    // `topLevel` and the SDK skips the doomed in-thread probe entirely.
    expect(h.requests.some((request) => request.url.includes('/replies?'))).toBe(false);
    expect(h.inThreadReplies).toEqual([]);
    expect(h.createdTopLevelReplies).toEqual(['bold italic code\nitem\nquote']);
  });

  it.each([
    {
      events: [{ type: 'error', message: 'boom', terminationReason: 'failed' }],
      reply: '⚠️ OMP 报错：boom',
    },
    {
      events: [{ type: 'done', terminationReason: 'normal' }],
      reply: '（无回复内容）',
    },
  ] as const)('preserves the $events.0.type terminal reply outcome', async ({ events, reply }) => {
    const h = await createCommentHarness({
      getResponse: commentGet({
        replyId: 'reply-terminal',
        question: 'terminal outcome',
        isWhole: false,
      }),
      agentEvents: events,
    });

    await handleCommentMention(h.deps(event({ replyId: 'reply-terminal' })));

    expect(h.inThreadReplies).toEqual([reply]);
  });
});

async function createCommentHarness(options: {
  wikiNode?: { obj_token: string; obj_type: string };
  getResponse?: unknown;
  getErrorCode?: number;
  listResponses?: unknown[];
  agentText?: string;
  agentEvents?: readonly AgentEvent[];
}): Promise<{
  tmp: TmpProfile;
  channel: FakeCommentChannel;
  requests: RequestRecord[];
  agent: FakeAgentAdapter;
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
  listCalls: number;
  inThreadReplies: string[];
  createdTopLevelReplies: string[];
  reactionActions(): string[];
}> {
  const tmp = await createTmpProfile('omp-comments-test-');

  const requests: RequestRecord[] = [];
  const inThreadReplies: string[] = [];
  const createdTopLevelReplies: string[] = [];
  let listCalls = 0;
  const listResponses = [...(options.listResponses ?? [])];

  const rawClient: FakeCommentChannel['rawClient'] = {
    async request(input) {
      requests.push(input);
      if (input.url.includes('/comments/reaction')) return {};
      if (input.url.includes('/replies?')) {
        inThreadReplies.push(extractText(input.data));
        return {};
      }
      return {};
    },
    wiki: {
      v2: {
        space: {
          async getNode() {
            if (!options.wikiNode) throw apiError(131005);
            return { data: { node: options.wikiNode } };
          },
        },
      },
    },
    drive: {
      v1: {
        fileComment: {
          async get() {
            if (options.getErrorCode) throw apiError(options.getErrorCode);
            return options.getResponse;
          },
          async list() {
            listCalls++;
            return listResponses.shift() ?? { data: { items: [] } };
          },
          async create(input) {
            createdTopLevelReplies.push(extractText(input));
            return {};
          },
        },
      },
    },
  };
  const channel: FakeCommentChannel = {
    requests,
    rawClient,
    comments: makeFakeCommentSurface(rawClient),
  };

  const agentEvents = options.agentEvents ?? [
    { type: 'system', sessionId: 'comment-session', cwd: tmp.workspace },
    { type: 'text', delta: options.agentText ?? '' },
    { type: 'done', sessionId: 'comment-session', terminationReason: 'normal' },
  ];
  const agent = new FakeAgentAdapter({ events: agentEvents });
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const sessionCatalog = new SessionCatalog(`${tmp.profile}/session-catalog.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  workspaces.setCwd('doc:doc-token', tmp.workspace);
  workspaces.setCwd('doc:wiki-token', tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    access: { allowedUsers: ['ou-user'] },
  });
  profileConfig.workspaces.default = tmp.workspace;
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const scopedRuns = new ScopedRuns({
    agent,
    pool,
    activeRuns,
    createRunId: () => `comment-run-${agent.runOptions.length + 1}`,
    sessionCatalog,
    workspaces,
    profile: 'work',
    profileConfig: () => profileConfig,
  });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    requests,
    agent,
    deps: (evt) => ({
      channel: channel as unknown as Parameters<typeof handleCommentMention>[0]['channel'],
      evt,
      sessions,
      scopedRuns,
      controls: {
        profile: 'work',
        profileConfig,
        botOwnerId: 'ou-user',
        ownerRefreshState: 'ok',
        async refreshOwner() {},
        configPath: `${tmp.profile}/config.json`,
        cfg: profileConfig,
        processId: 'proc-1',
        async restart() {},
        async exit() {},
      },
    }),
    get listCalls() {
      return listCalls;
    },
    inThreadReplies,
    createdTopLevelReplies,
    reactionActions: () =>
      requests
        .filter((r) => r.url.includes('/comments/reaction'))
        .map((r) => (r.data as { action?: string }).action ?? ''),
  };
}

function event(overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment-1',
    replyId: 'reply-1',
    mentionedBot: true,
    operator: { openId: 'ou-user' },
    ...overrides,
  } as CommentEvent;
}

function commentGet(options: {
  replyId: string;
  question: string;
  quote?: string;
  isWhole?: boolean;
}): unknown {
  return {
    data: {
      quote: options.quote,
      is_whole: options.isWhole,
      reply_list: {
        replies: [reply(options.replyId, options.question)],
      },
    },
  };
}

function commentListItem(options: {
  commentId: string;
  replyId: string;
  question: string;
  quote?: string;
  isWhole?: boolean;
}): unknown {
  return {
    comment_id: options.commentId,
    quote: options.quote,
    is_whole: options.isWhole,
    reply_list: { replies: [reply(options.replyId, options.question)] },
  };
}

function reply(replyId: string, text: string): unknown {
  return {
    reply_id: replyId,
    content: {
      elements: [{ type: 'text_run', text_run: { text } }],
    },
  };
}

function apiError(code: number): Error {
  const err = new Error(`api ${code}`) as Error & { response: { data: { code: number } } };
  err.response = { data: { code } };
  return err;
}

function extractText(value: unknown): string {
  const data = value as Record<string, unknown>;
  const content = readContentText(data.content);
  if (content !== undefined) return content;
  const nestedData = data.data as Record<string, unknown> | undefined;
  const direct = readContentText(nestedData?.content);
  if (direct !== undefined) return direct;
  const nestedReply = readReplyText(nestedData?.reply_list);
  if (nestedReply !== undefined) return nestedReply;
  return readReplyText(data.reply_list) ?? '';
}

function readContentText(value: unknown): string | undefined {
  const content = value as { elements?: Array<{ text_run?: { text?: string } }> } | undefined;
  return content?.elements?.[0]?.text_run?.text;
}

function readReplyText(value: unknown): string | undefined {
  const replyList = value as
    | {
        replies?: Array<{ content?: { elements?: Array<{ text_run?: { text?: string } }> } }>;
      }
    | undefined;
  return replyList?.replies?.[0]?.content?.elements?.[0]?.text_run?.text;
}
