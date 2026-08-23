import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { CommentEvent, CommentTarget, LarkChannel } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types';
import type { Controls } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import type { ScopeContext } from '../policy/run-policy';
import type { SessionStore } from '../session/store';
import { commentDocumentScopeId, commentScopeId, commentTokenDigest } from './comment-resource';
import type { RunFlowRejectCode, ScopedRuns } from './run-flow';

export { commentDocumentScopeId, commentScopeId } from './comment-resource';

export interface CommentDeps {
  channel: LarkChannel;
  evt: CommentEvent;
  sessions: SessionStore;
  scopedRuns: ScopedRuns;
  controls: Controls;
}

// File types supported by drive.v1.fileComment.get; other types (slides,
// bitable, mindnote) use different APIs and are out of scope for now.
const REPLY_MAX_CHARS = 2000;
const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'file']);

export interface ReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}
export interface CommentReply {
  reply_id?: string;
  content?: { elements?: ReplyContentElement[] };
}

export interface CommentContext {
  question: string;
  quote?: string;
  isWhole: boolean;
  /** The reply_id of the reply that contains the @bot mention — the anchor
   * we react on. Undefined when we couldn't pinpoint a reply (top-level
   * comment with no replies fetched, etc.). */
  targetReplyId?: string;
  /** Text of the replies in this comment thread that came before the @bot
   * reply, chronological. Feishu delivers the whole thread but the bot is only
   * @-ed on one reply; without these it can't see what the thread is about (a
   * bare "说说你的思考" points at a discussion it would otherwise never see). */
  priorReplies: string[];
}

export interface ExtractCommentQuestionInput {
  replyId?: string;
  replies: CommentReply[];
}

export interface ExtractCommentQuestionResult {
  question: string;
  targetReplyId?: string;
}

/**
 * Handle a `comment` event: when the bot is @-mentioned in a cloud-doc
 * comment, fetch the comment text, run the agent, and post the answer as
 * a reply in the same comment thread.
 */
export async function handleCommentMention(deps: CommentDeps): Promise<void> {
  const { channel, evt, sessions, scopedRuns, controls } = deps;
  const eventDocScopeId = commentDocumentScopeId(evt.fileToken);
  const eventCommentScopeId = commentScopeId(evt.fileToken, evt.commentId);
  // Log every comment event we receive, regardless of whether we'll act on it.
  // `mentionedBot` and `replyId` here let us tell apart top-level comments
  // from thread replies (the latter requires SDK ≥ 1.65.0-alpha.0).
  log.info('comment', 'enter', {
    docScopeId: eventDocScopeId,
    fileType: evt.fileType,
    commentScopeId: eventCommentScopeId,
    replyDigest: evt.replyId ? commentTokenDigest(evt.replyId) : undefined,
    mentionedBot: evt.mentionedBot,
    sender: evt.operator.openId,
  });
  if (!evt.mentionedBot) {
    log.info('comment', 'skip', { reason: 'not-mentioned' });
    return;
  }
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
    log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
    return;
  }
  if (isBridgeSelfReply(channel, evt)) {
    log.info('comment', 'skip', {
      reason: 'bridge-self-reply',
      commentScopeId: eventCommentScopeId,
    });
    return;
  }
  const target = await channel.comments.resolveTarget(evt.fileToken, evt.fileType);
  if (!target) {
    log.info('comment', 'skip', {
      reason: 'unsupported-target',
      commentScopeId: eventCommentScopeId,
    });
    return;
  }
  const targetDocScopeId = commentDocumentScopeId(target.fileToken);
  const commentThreadScopeId = eventCommentScopeId;
  const runScopeId = commentExecutionScopeId(commentThreadScopeId);
  const agentSessionScopeId = commentDocumentSessionScopeId(target.fileToken);

  const ctx = await fetchCommentContext(channel, target, evt).catch((err) => {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    if (code === 1069307) {
      log.warn('comment', 'no-access', { docDigest: commentTokenDigest(target.fileToken) });
    } else {
      log.fail('comment', err, { step: 'fetchCommentContext' });
    }
    return null;
  });
  if (!ctx?.question) {
    log.info('comment', 'skip', { reason: 'empty-question' });
    return;
  }
  log.info('comment', 'parsed', {
    commentScopeId: runScopeId,
    isWhole: ctx.isWhole,
    questionPreview: preview(ctx.question),
    hasQuote: Boolean(ctx.quote),
  });
  const prompt = buildCommentPrompt(target, ctx);

  // Cloud-doc comments have no streaming UI — the user just sees their
  // @-mention sit there until our reply lands. Mark the triggering reply
  // with a "Typing" reaction up-front so they know we got it; clear it in
  // the finally below regardless of how the run ends.
  const reactionAdded = ctx.targetReplyId
    ? await channel.comments.addReaction(target, ctx.targetReplyId)
    : false;

  try {
    const runTimeoutMs = commentRunTimeoutMs(sessions, runScopeId);
    const threadTimeoutMs = commentRunTimeoutMs(sessions, commentThreadScopeId);
    const commentTimeoutMs = runTimeoutMs !== undefined ? runTimeoutMs : threadTimeoutMs;
    if (typeof commentTimeoutMs === 'number') {
      log.info('comment', 'timeout-watchdog', {
        commentScopeId: runScopeId,
        timeoutMs: commentTimeoutMs,
      });
    }
    const runContext: ScopeContext = {
      source: 'comment',
      actorId: evt.operator.openId,
      commentScopeId: agentSessionScopeId,
      resourceBindings: [{ kind: 'doc', id: targetDocScopeId, verified: true }],
    };
    const started = await scopedRuns.start({
      scopeId: runScopeId,
      sessionScopeId: agentSessionScopeId,
      scope: runContext,
      prompt,
      attachments: [],
      access: { ok: true, reason: 'comment-mention' },
      managedFallbackCwd: managedDefaultWorkspaceForComments(controls),
      ...(typeof commentTimeoutMs === 'number' ? { ttlMs: commentTimeoutMs } : {}),
    });
    if (!started.ok) {
      log.info('comment', 'skip', {
        reason: started.rejectReason.code,
        commentScopeId: runScopeId,
      });
      const reply = commentRunRejectedReply(started.rejectReason);
      if (reply) {
        await postCommentReply(channel, target, evt, reply, { isWhole: ctx.isWhole }).catch(
          (err) => {
            log.fail('comment', err, { step: 'postRunRejectedReply' });
          },
        );
      }
      return;
    }

    const run = started.run;
    const commentExpiresAt =
      typeof commentTimeoutMs === 'number' ? run.metadata.expiresAt : undefined;
    log.info('comment', 'session', {
      commentScopeId: runScopeId,
      sessionScopeId: agentSessionScopeId,
      resume: Boolean(run.metadata.resumeFrom),
      cwd: run.metadata.cwdRealpath,
    });

    let answer = '';
    let errorMsg: string | undefined;
    let terminal = false;
    let timedOut = false;
    const eventStream = run.events[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextCommentEvent(eventStream, commentExpiresAt);
        if (
          next === 'expired' ||
          (commentExpiresAt !== undefined && Date.now() > commentExpiresAt)
        ) {
          await run.stop().catch((err) => {
            log.warn('comment', 'expired-stop-failed', {
              commentScopeId: runScopeId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
          timedOut = true;
          terminal = true;
          break;
        }
        if (next.done || run.wasInterrupted()) {
          terminal = true;
          break;
        }
        const e = next.value;
        switch (e.type) {
          case 'text':
            answer += e.delta;
            break;
          case 'final_text':
            answer = e.content;
            break;
          case 'tool_use':
          case 'tool_result':
            answer = '';
            break;
          case 'system':
            break;
          case 'error':
            errorMsg = e.message;
            terminal = true;
            break;
          case 'usage':
            break;
          case 'done':
            terminal = true;
            break;
        }
        // Stop at the terminal event rather than waiting for OMP's process
        // cleanup tail to close stdout.
        if (terminal) break;
      }
    } finally {
      await eventStream.return?.();
    }

    if (timedOut) {
      log.info('comment', 'reply-skip', {
        reason: 'policy-expired',
        commentScopeId: runScopeId,
      });
      await postCommentReply(channel, target, evt, '本次评论任务已超时，请重新 @ 我。', {
        isWhole: ctx.isWhole,
      }).catch((err) => {
        log.fail('comment', err, { step: 'postTimeoutReply' });
      });
      return;
    }

    if (run.wasInterrupted()) {
      log.info('comment', 'reply-skip', {
        reason: 'interrupted',
        commentScopeId: runScopeId,
      });
      return;
    }

    let reply = stripMarkdown(answer.trim());
    if (errorMsg) reply = `⚠️ OMP 报错：${errorMsg}`;
    if (!reply) reply = '（无回复内容）';
    if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

    await postCommentReply(channel, target, evt, reply, { isWhole: ctx.isWhole }).catch((err) => {
      log.fail('comment', err, { step: 'postCommentReply' });
      log.warn('comment', 'reply_failed', {
        commentScopeId: runScopeId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } finally {
    if (reactionAdded && ctx.targetReplyId) {
      await channel.comments.removeReaction(target, ctx.targetReplyId);
    }
  }
}

export type ResolvedTarget = CommentTarget;

async function fetchCommentContext(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
): Promise<CommentContext> {
  // The SDK's CommentSurface internalizes the `.get` → paginated `.list`
  // fallback (some comment types return 1069307 on `.get` despite read
  // access). A genuine no-access (1069307 on both) propagates here so the
  // caller's catch can log it as no-access.
  const fetched = await channel.comments.fetch(target, evt.commentId);
  const replies = fetched?.replies ?? [];
  const parsed = extractCommentQuestionFromReplies({ replyId: evt.replyId, replies });
  // The whole thread comes back, but only one reply @-ed the bot. Carry the
  // replies before it as context so the agent sees the discussion it's being
  // pulled into, not just the pointer reply. `targetIdx < 0` (no reply_id, so
  // the parser fell back to the last reply) → everything except that last one.
  const targetIdx = parsed?.targetReplyId
    ? replies.findIndex((reply) => reply.reply_id === parsed.targetReplyId)
    : replies.length - 1;
  const priorReplies = (targetIdx > 0 ? replies.slice(0, targetIdx) : [])
    .map(replyElementsToText)
    .filter((text) => text.length > 0);
  return {
    question: parsed?.question ?? '',
    quote: fetched?.quote,
    isWhole: Boolean(fetched?.isWhole),
    targetReplyId: parsed?.targetReplyId,
    priorReplies,
  };
}

/** Flatten a comment reply's content elements into plain text (text runs and
 * doc links; @-mention `person` elements are dropped as they carry no text). */
function replyElementsToText(reply: CommentReply): string {
  const elements = reply.content?.elements ?? [];
  return elements
    .map((el) => {
      if (el.type === 'text_run') return el.text_run?.text ?? '';
      if (el.type === 'docs_link') return el.docs_link?.url ?? '';
      return '';
    })
    .join('')
    .trim();
}

export function extractCommentQuestionFromReplies(
  input: ExtractCommentQuestionInput,
): ExtractCommentQuestionResult | null {
  let targetReply: CommentReply | undefined;
  if (input.replyId) {
    targetReply = input.replies.find((reply) => reply.reply_id === input.replyId);
  }
  targetReply ??= input.replies.at(-1);
  if (!targetReply) return null;

  const question = replyElementsToText(targetReply);
  return { question, targetReplyId: targetReply.reply_id };
}

export function buildCommentPrompt(target: ResolvedTarget, ctx: CommentContext): string {
  const docUrl = `https://feishu.cn/${target.fileType}/${target.fileToken}`;
  const parts: string[] = [];
  parts.push('我在飞书云文档里被 @了。文档信息：');
  parts.push(`- 链接：${docUrl}`);
  parts.push(`- file_token：${target.fileToken}`);
  parts.push(`- 类型：${target.fileType}`);
  parts.push(`- 评论范围：${ctx.isWhole ? '全文评论（针对整篇）' : '行内评论（针对选中文字）'}`);
  if (ctx.quote) {
    parts.push('');
    parts.push(`用户选中的原文：\n> ${ctx.quote.replace(/\n/g, '\n> ')}`);
  }
  if (ctx.priorReplies.length > 0) {
    parts.push('');
    parts.push('这条评论 thread 里此前的讨论（按时间顺序，@你的那条不在其中）：');
    ctx.priorReplies.forEach((text, i) => {
      parts.push(`${i + 1}. ${text}`);
    });
  }
  parts.push('');
  parts.push(`用户的问题：${ctx.question}`);
  parts.push('');
  parts.push(commentReadInstruction(target));
  parts.push('');
  parts.push(
    '评论回复由 bridge 负责：不要调用云文档评论或回复接口，也不要给评论添加或删除 reaction；最终答案直接用纯文本交给 bridge。',
  );
  parts.push('');
  parts.push(
    '回复要求：直接用纯文本，不要 markdown（不要 ** __ # - * > ` 之类的标记），不要代码块；不要输出内部思考、内部分析、读取步骤、工具调用过程或工具日志。若用户要求解释依据，只说明用户可见的依据和结论。云文档评论框不渲染 markdown，会原样显示这些符号。',
  );
  return parts.join('\n');
}

function commentRunRejectedReply(rejectReason: {
  code: RunFlowRejectCode;
  userVisible: string;
}): string | undefined {
  switch (rejectReason.code) {
    case 'run-already-active':
      return '当前评论线程已有任务在执行，请稍后再试。';
    case 'pool-full':
      return '当前任务较多，请稍后再试。';
    case 'reconnect-in-progress':
      return '当前 bot 正在重连，请稍后再试。';
    case 'policy-expired':
      return '本次评论任务已超时，请重新 @ 我。';
    case 'access-denied':
    case 'folder-allowlist-unverified':
    case 'required-attachment-rejected':
    case 'unsupported-agent-access':
      return undefined;
    default:
      return `工作目录不可用：${rejectReason.userVisible}`;
  }
}

function commentExecutionScopeId(commentThreadScopeId: string): string {
  return `${commentThreadScopeId}:${randomUUID().slice(0, 12)}`;
}

function commentDocumentSessionScopeId(fileToken: string): string {
  return `doc:${commentTokenDigest(fileToken)}`;
}

function managedDefaultWorkspaceForComments(controls: Controls): string {
  return resolveAppPaths({
    rootDir: dirname(controls.configPath),
    profile: controls.profile,
  }).defaultWorkspaceDir;
}

function commentReadInstruction(target: ResolvedTarget): string {
  if (target.fileType === 'doc' || target.fileType === 'docx') {
    return `需要全文时，用 lark_get_document_blocks 读取 document_id ${target.fileToken}；按 page_token 继续翻页。`;
  }
  return `bridge 尚未提供 ${target.fileType} 正文读取工具；只根据当前评论上下文回答，不能读取时明确说明。`;
}

function isBridgeSelfReply(channel: LarkChannel, evt: CommentEvent): boolean {
  const botOpenId = (channel as { botIdentity?: { openId?: string } }).botIdentity?.openId;
  if (botOpenId && evt.operator.openId === botOpenId) return true;

  const raw = evt as unknown as Record<string, unknown>;
  if (raw.bridgeReply === true) return true;
  if (raw.bridge_reply === true) return true;

  const metadata = raw.replyMetadata ?? raw.reply_metadata ?? raw.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const record = metadata as Record<string, unknown>;
  return (
    record.bridge === true || record.bridgeReply === true || record.source === 'lark-bot-bridge'
  );
}

/**
 * Strip the most common markdown markers so a plain-text comment doesn't
 * show literal `**` / `#` / `> ` etc. Conservative — only touches bold,
 * italic, headings, blockquote, list bullets, and inline code.
 */
export function stripMarkdown(s: string): string {
  return (
    s
      // headings: "# foo" -> "foo"
      .replace(/^#{1,6}\s+/gm, '')
      // bold/italic: **foo** / __foo__ / *foo* / _foo_
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
      // inline code: `foo`
      .replace(/`([^`]+)`/g, '$1')
      // unordered list bullets: "- foo" / "* foo"
      .replace(/^[-*]\s+/gm, '')
      // blockquote
      .replace(/^>\s?/gm, '')
      // remove fenced code-block backticks but keep contents
      .replace(/```[a-zA-Z]*\n?/g, '')
      .replace(/```/g, '')
  );
}

function commentRunTimeoutMs(sessions: SessionStore, scopeId: string): number | null | undefined {
  const scopeOverride = sessions.getIdleTimeoutMinutes(scopeId);
  if (scopeOverride !== undefined) {
    return scopeOverride > 0 ? scopeOverride * 60_000 : null;
  }
  return undefined;
}

async function nextCommentEvent(
  iterator: AsyncIterator<AgentEvent>,
  expiresAt: number | undefined,
): Promise<IteratorResult<AgentEvent> | 'expired'> {
  if (expiresAt === undefined) {
    return iterator.next();
  }
  const delayMs = Math.max(0, expiresAt - Date.now() + 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), delayMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postCommentReply(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
  text: string,
  opts: { isWhole?: boolean } = {},
): Promise<void> {
  // CommentSurface tries in-thread first and, on the 1069302 that whole-doc
  // comments return (no thread, only a flat list), falls back to posting a
  // fresh top-level comment. When we already know it's whole-document, skip
  // the doomed probe with `topLevel`.
  await channel.comments.reply(target, evt.commentId, text, { topLevel: opts.isWhole });
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
