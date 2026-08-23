import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommentEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { commentTokenDigest } from '../../../src/bot/comment-resource.js';
import { handleCommentMention } from '../../../src/bot/comments.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
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
    request(input: RequestRecord): Promise<unknown>;
    wiki: { v2: { space: { getNode(input: unknown): Promise<unknown> } } };
    drive: {
      v1: {
        fileComment: {
          get(input: { path: { comment_id: string } }): Promise<unknown>;
          list(input: unknown): Promise<unknown>;
          create(input: unknown): Promise<unknown>;
        };
      };
    };
  };
}

const cleanups: Array<() => Promise<void>> = [];

describe('comment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs mentioned comments through ScopedRuns with the document token prompt', async () => {
    const h = await createHarness();

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.prompt).toContain('file_token：doc-token');
    expect(opts.prompt).toContain('lark_get_document_blocks 读取 document_id doc-token');
    expect(opts.prompt).not.toContain('commentScopeId');
    expect(opts.prompt).not.toContain('docScopeId');
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('includes the prior thread replies as context when @-ed on a later reply', async () => {
    const h = await createHarness({
      commentReplies: [
        { reply_id: 'reply-a', text: '这段方案有个风险' },
        { reply_id: 'reply-b', text: '我觉得可以拆成两步' },
        { reply_id: 'reply-1', text: '@bot 说说你的思考' },
      ],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]!.prompt;
    // the two replies before the @bot reply are surfaced as context
    expect(prompt).toContain('此前的讨论');
    expect(prompt).toContain('这段方案有个风险');
    expect(prompt).toContain('我觉得可以拆成两步');
    // the @bot reply is the question, not duplicated into the prior-discussion list
    expect(prompt).toContain('用户的问题：@bot 说说你的思考');
    const priorBlock = prompt.slice(prompt.indexOf('此前的讨论'), prompt.indexOf('用户的问题'));
    expect(priorBlock).not.toContain('说说你的思考');
  });

  it('shares OMP sessions across different comment threads in the same document', async () => {
    const h = await createHarness({
      agentTexts: ['first answer', 'second answer', 'third answer'],
      sessionIds: ['session-one', 'session-two', 'session-three'],
    });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-2', replyId: 'reply-2' })));
    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toHaveLength(3);
    expect(h.agent.runOptions[0]?.sessionId).toBeUndefined();
    expect(h.agent.runOptions[1]?.sessionId).toBe('session-one');
    expect(h.agent.runOptions[2]?.sessionId).toBe('session-two');
    expect(
      h.sessionCatalog.entries().find((entry) => entry.scopeId === docSessionScope('doc-token')),
    ).toMatchObject({ sessionId: 'session-three' });
  });


  it('keeps replying when typing reaction add fails', async () => {
    const h = await createHarness({ reactionFails: true });

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('falls back to the default cwd when the document cwd is stale', async () => {
    const h = await createHarness();
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    const defaultCwd = await realpath(h.tmp.workspace);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(defaultCwd);
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('uses a managed fallback cwd when both document and default cwd are stale', async () => {
    const h = await createHarness();
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));
    h.profileConfig.workspaces.default = join(h.tmp.profile, 'missing-default-workspace');

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    const managedCwd = await realpath(join(`${h.tmp.profile}-workspaces`, 'work', 'default'));
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(managedCwd);
    expect(h.inThreadReplies).toEqual(['answer one']);
  });

  it('replies without starting the agent only when no cwd fallback can be created', async () => {
    const h = await createHarness();
    await writeFile(`${h.tmp.profile}-workspaces`, 'not a directory');
    h.workspaces.setCwd(docSessionScope('doc-token'), join(h.tmp.profile, 'missing-workspace'));
    h.profileConfig.workspaces.default = join(h.tmp.profile, 'missing-default-workspace');

    await handleCommentMention(h.deps(event({ commentId: 'comment-1', replyId: 'reply-1' })));

    expect(h.agent.runOptions).toEqual([]);
    expect(h.inThreadReplies.at(-1)).toContain('工作目录不可用');
  });
});

async function createHarness(
  options: {
    agentTexts?: string[];
    agentEventRuns?: AgentEvent[][];
    sessionIds?: string[];
    reactionFails?: boolean;
    /** Full reply_list (chronological) returned by fileComment.get for comment-1.
     * Lets a test model a thread with replies preceding the @bot reply. */
    commentReplies?: Array<{ reply_id: string; text: string }>;
  } = {},
): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ProfileConfig;
  scopedRuns: ScopedRuns;
  inThreadReplies: string[];
  deps(evt: CommentEvent): Parameters<typeof handleCommentMention>[0];
}> {
  const tmp = await createTmpProfile('comment-run-flow-');
  const requests: RequestRecord[] = [];
  const inThreadReplies: string[] = [];
  const agentTexts = options.agentTexts ?? ['answer one'];
  const sessionIds = options.sessionIds ?? ['session-one'];
  const eventRuns: AgentEvent[][] =
    options.agentEventRuns ??
    agentTexts.map((text, index) => [
      {
        type: 'system',
        sessionId: sessionIds[index] ?? `session-${index}`,
        cwd: tmp.workspace,
      },
      { type: 'text', delta: text },
      {
        type: 'done',
        sessionId: sessionIds[index] ?? `session-${index}`,
        terminationReason: 'normal',
      },
    ]);
  const agent = new FakeAgentAdapter({ events: eventRuns });
  const rawClient: FakeCommentChannel['rawClient'] = {
    async request(input) {
      requests.push(input);
      if (input.url.includes('/comments/reaction')) {
        if (options.reactionFails) throw new Error('reaction failed');
        return {};
      }
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
            throw apiError(131005);
          },
        },
      },
    },
    drive: {
      v1: {
        fileComment: {
          async get(input) {
            const commentId = input.path.comment_id;
            const replyId = commentId === 'comment-2' ? 'reply-2' : 'reply-1';
            if (options.commentReplies && commentId === 'comment-1') {
              return {
                data: {
                  reply_list: {
                    replies: options.commentReplies.map((r) => ({
                      reply_id: r.reply_id,
                      content: { elements: [{ type: 'text_run', text_run: { text: r.text } }] },
                    })),
                  },
                },
              };
            }
            return commentGet(replyId, '@bot question');
          },
          async list() {
            return { data: { items: [] } };
          },
          async create() {
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
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(docSessionScope('doc-token'), tmp.workspace);
  const profileConfig = profile(tmp.workspace);
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
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    profileConfig,
    scopedRuns,
    inThreadReplies,
    deps: (evt) => ({
      channel: channel as unknown as Parameters<typeof handleCommentMention>[0]['channel'],
      evt,
      sessions,
      scopedRuns,
      controls: {
        profile: 'work',
        profileConfig,
        botOwnerId: 'ou-owner',
        ownerRefreshState: 'ok',
        async refreshOwner() {},
        configPath: join(tmp.profile, 'config.json'),
        cfg: profileConfig,
        processId: 'proc-1',
        async restart() {},
        async exit() {},
      },
    }),
  };
}

function profile(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers: ['ou-user'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function docSessionScope(fileToken: string): string {
  return `doc:${commentTokenDigest(fileToken)}`;
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

function commentGet(replyId: string, question: string): unknown {
  return {
    data: {
      reply_list: {
        replies: [
          {
            reply_id: replyId,
            content: { elements: [{ type: 'text_run', text_run: { text: question } }] },
          },
        ],
      },
    },
  };
}

function extractText(value: unknown): string {
  const data = value as { content?: { elements?: Array<{ text_run?: { text?: string } }> } };
  return data.content?.elements?.[0]?.text_run?.text ?? '';
}

function apiError(code: number): Error {
  const err = new Error(`api ${code}`) as Error & { response: { data: { code: number } } };
  err.response = { data: { code } };
  return err;
}
