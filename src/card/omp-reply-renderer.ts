import {
  sanitizeImAnswer,
  substitutionMentionOpenIds,
  type ImReplyPlan,
} from '../bot/im-invocation';
import { deepMaskEmails, maskEmails } from './mask-email';
import type { RunState, ToolEntry, ToolStatus } from './run-state';

const MAX_CARD_BYTES = 30 * 1024;
const MAX_CARD_ELEMENTS = 200;
const TRUNCATION_MARKER = '内容过长，已截断';

export type ReplyMentionMode = 'mention' | 'plain' | 'omit';

type RenderOptions = Readonly<{
  streamingMode: boolean;
  toolCount?: number | null;
  mentionMode?: ReplyMentionMode;
}>;

type ReplyInput = RunState | ImReplyPlan;

type OmpReplyPresentation = Readonly<{
  finalReply: string;
  statusLabel: string;
  summary: string;
}>;

export function renderOmpReplyCard(input: ReplyInput, options?: RenderOptions): object {
  const state = replyState(input);
  let reasoning = state.reasoningEntries ?? [];
  let tools = state.tools;
  const finalText = ompReplyPresentation(state).finalReply;
  let card = buildOmpReplyCard(input, reasoning, tools, finalText, options);

  while (!withinCardBudget(card) && reasoning.length > 0) {
    reasoning = reasoning.slice(1);
    card = buildOmpReplyCard(input, reasoning, tools, finalText, options);
  }
  while (!withinCardBudget(card) && tools.length > 0) {
    tools = tools.slice(1);
    card = buildOmpReplyCard(input, reasoning, tools, finalText, options);
  }
  if (!withinCardBudget(card) && state.terminal === 'done') {
    card = truncateFinalReply(input, reasoning, tools, finalText, options);
  }
  return card;
}

function buildOmpReplyCard(
  input: ReplyInput,
  reasoning: readonly string[],
  tools: readonly ToolEntry[],
  finalText: string,
  options: RenderOptions | undefined,
): object {
  const state = replyState(input);
  const running = state.terminal === 'running';
  const presentation = ompReplyPresentation(state);
  const activity = state.activityStack?.at(-1)?.label;
  const reasoningTotal = state.reasoningTotal ?? reasoning.length;
  const toolCount =
    options?.toolCount === null ? undefined : (options?.toolCount ?? state.metrics.toolIds.length);
  const showReasoning = running || reasoningTotal > 0;
  const showTools = running || (toolCount !== undefined && toolCount > 0);
  return deepMaskEmails({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: options?.streamingMode ?? running,
      summary: { content: presentation.summary },
    },
    header: {
      title: { tag: 'plain_text', content: running ? '正在处理' : '回复' },
      ...(activity ? { subtitle: { tag: 'plain_text', content: activity } } : {}),
      template: state.terminal === 'done' ? 'green' : running ? 'blue' : 'red',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: presentation.statusLabel },
          color: state.terminal === 'done' ? 'green' : running ? 'blue' : 'red',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        ...(showReasoning
          ? [
              disclosure(
                'reasoning',
                `💭 中间过程（${reasoningTotal} 条）`,
                running,
                reasoning.length > 0
                  ? reasoning.flatMap((entry, index) => [
                      ...(index > 0 ? [{ tag: 'hr' }] : []),
                      { tag: 'markdown', content: escapeMarkdown(entry), text_size: 'body' },
                    ])
                  : [placeholder('等待思考过程…')],
              ),
            ]
          : []),
        {
          tag: 'markdown',
          element_id: 'answer',
          content: running
            ? "**正在完成请求**\n<font color='grey'>回复会在确认后原位出现。</font>"
            : withSenderOwnership(input, finalText, options?.mentionMode),
          text_size: 'body',
        },
        ...metricsElements(state),
        ...(showTools
          ? [
              disclosure('tools', `🔧 调用工具 ${toolCount ?? 0} 次`, running, [
                {
                  tag: 'markdown',
                  content:
                    tools.length > 0
                      ? tools.map((tool) => toolRow(tool)).join('\n')
                      : "<font color='grey'>尚未调用工具</font>",
                  text_size: 'notation',
                },
              ]),
            ]
          : []),
      ],
    },
  });
}

function truncateFinalReply(
  input: ReplyInput,
  reasoning: readonly string[],
  tools: readonly ToolEntry[],
  finalText: string,
  options: RenderOptions | undefined,
): object {
  if (isImReplyPlan(input) && input.peerActivation) {
    let lower = 0;
    let upper = finalText.length - (input.peerActivation.end - input.peerActivation.start);
    let preserved = peerPreservingReply(input, finalText, 0);
    let best = buildOmpReplyCard(
      preserved.input,
      reasoning,
      tools,
      preserved.finalText,
      options,
    );
    while (lower < upper) {
      const middle = Math.floor((lower + upper + 1) / 2);
      const candidateReply = peerPreservingReply(input, finalText, middle);
      const candidate = buildOmpReplyCard(
        candidateReply.input,
        reasoning,
        tools,
        candidateReply.finalText,
        options,
      );
      if (withinCardBudget(candidate)) {
        lower = middle;
        preserved = candidateReply;
        best = candidate;
      } else {
        upper = middle - 1;
      }
    }
    return best;
  }

  let lower = 0;
  let upper = finalText.length;
  let best = buildOmpReplyCard(input, reasoning, tools, TRUNCATION_MARKER, options);
  while (lower < upper) {
    let middle = codePointBoundary(finalText, Math.floor((lower + upper + 1) / 2));
    if (middle <= lower) middle = upper;
    const candidate = buildOmpReplyCard(
      input,
      reasoning,
      tools,
      `${finalText.slice(0, middle)}${TRUNCATION_MARKER}`,
      options,
    );
    if (withinCardBudget(candidate)) {
      lower = middle;
      best = candidate;
    } else {
      upper = previousCodePointBoundary(finalText, middle);
    }
  }
  return best;
}

function withinCardBudget(card: object): boolean {
  return (
    Buffer.byteLength(JSON.stringify(card)) <= MAX_CARD_BYTES &&
    countCardElements(card) <= MAX_CARD_ELEMENTS
  );
}

function countCardElements(card: object): number {
  return ('header' in card ? 1 : 0) + countNestedElements(card);
}

function countNestedElements(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'elements' && Array.isArray(child)) {
      count += child.length;
      for (const element of child) count += countNestedElements(element);
    } else {
      count += countNestedElements(child);
    }
  }
  return count;
}

function codePointBoundary(value: string, index: number): number {
  const previousCode = value.charCodeAt(index - 1);
  const nextCode = value.charCodeAt(index);
  return index > 0 &&
    index < value.length &&
    previousCode >= 0xd800 &&
    previousCode <= 0xdbff &&
    nextCode >= 0xdc00 &&
    nextCode <= 0xdfff
    ? index - 1
    : index;
}

function previousCodePointBoundary(value: string, index: number): number {
  const previous = index - 1;
  const previousCode = value.charCodeAt(previous);
  const precedingCode = value.charCodeAt(previous - 1);
  return previous > 0 &&
    previousCode >= 0xdc00 &&
    previousCode <= 0xdfff &&
    precedingCode >= 0xd800 &&
    precedingCode <= 0xdbff
    ? previous - 1
    : previous;
}

function peerPreservingReply(
  input: ImReplyPlan,
  finalText: string,
  contextLength: number,
): { input: ImReplyPlan; finalText: string } {
  const activation = input.peerActivation;
  if (!activation) return { input, finalText };
  const tokenLength = activation.end - activation.start;
  const preserveWholePrefix = contextLength >= activation.start;
  const sliceStart = preserveWholePrefix ? 0 : activation.start;
  const remainingContext = Math.max(0, contextLength - (activation.start - sliceStart));
  const sliceEnd = codePointBoundary(
    finalText,
    activation.end + Math.min(finalText.length - activation.end, remainingContext),
  );
  const prefix = sliceStart > 0 ? `${TRUNCATION_MARKER}\n` : '';
  const suffix = sliceEnd < finalText.length ? `\n${TRUNCATION_MARKER}` : '';
  const truncated = `${prefix}${finalText.slice(sliceStart, sliceEnd)}${suffix}`;
  const start = prefix.length + activation.start - sliceStart;
  return {
    finalText: truncated,
    input: {
      ...input,
      state: { ...input.state, finalText: truncated },
      peerActivation: {
        ...activation,
        start,
        end: start + tokenLength,
      },
    },
  };
}

type RenderedMarkdown = Readonly<{ input: ReplyInput; markdown: string }>;

function renderedOmpReplyMarkdown(
  input: ReplyInput,
  mentionMode?: ReplyMentionMode,
): RenderedMarkdown {
  const state = replyState(input);
  if (state.terminal === 'running') {
    throw new Error('cannot render a running OMP Reply as terminal Markdown');
  }
  const finalText = ompReplyPresentation(state).finalReply;
  const full = buildOmpReplyMarkdown(input, finalText, mentionMode);
  const fullFits =
    isImReplyPlan(input) && input.peerActivation
      ? withinPeerMarkdownBudget(full)
      : withinMarkdownBudget(full);
  if (fullFits || state.terminal !== 'done') return { input, markdown: full };
  if (isImReplyPlan(input) && input.peerActivation) {
    let lower = 0;
    let upper = finalText.length - (input.peerActivation.end - input.peerActivation.start);
    let preserved = peerPreservingReply(input, finalText, 0);
    let best = buildOmpReplyMarkdown(preserved.input, preserved.finalText, mentionMode);
    while (lower < upper) {
      const middle = Math.floor((lower + upper + 1) / 2);
      const candidateReply = peerPreservingReply(input, finalText, middle);
      const candidate = buildOmpReplyMarkdown(
        candidateReply.input,
        candidateReply.finalText,
        mentionMode,
      );
      if (withinPeerMarkdownBudget(candidate)) {
        lower = middle;
        preserved = candidateReply;
        best = candidate;
      } else {
        upper = middle - 1;
      }
    }
    return { input: preserved.input, markdown: best };
  }

  let lower = 0;
  let upper = finalText.length;
  let best = buildOmpReplyMarkdown(input, TRUNCATION_MARKER, mentionMode);
  while (lower < upper) {
    let middle = codePointBoundary(finalText, Math.floor((lower + upper + 1) / 2));
    if (middle <= lower) middle = upper;
    const candidate = buildOmpReplyMarkdown(
      input,
      `${finalText.slice(0, middle)}${TRUNCATION_MARKER}`,
      mentionMode,
    );
    if (withinMarkdownBudget(candidate)) {
      lower = middle;
      best = candidate;
    } else {
      upper = previousCodePointBoundary(finalText, middle);
    }
  }
  return { input, markdown: best };
}

export function renderOmpReplyMarkdown(
  input: ReplyInput,
  mentionMode?: ReplyMentionMode,
): string {
  return renderedOmpReplyMarkdown(input, mentionMode).markdown;
}

export function renderOmpReplyMarkdownPost(
  input: ReplyInput,
  mentionMode: ReplyMentionMode = 'mention',
): object {
  const state = replyState(input);
  if (state.terminal === 'running') {
    throw new Error('cannot render a running OMP Reply as terminal Markdown');
  }
  const finalText = ompReplyPresentation(state).finalReply;
  if (
    isImReplyPlan(input) &&
    input.invocationKind === 'ordinary' &&
    input.peerActivation
  ) {
    return buildOmpReplyMarkdownPost(input, finalText, mentionMode);
  }
  const full = buildOmpReplyMarkdownPost(input, finalText, mentionMode);
  if (withinPostBudget(full) || state.terminal !== 'done') return full;

  let lower = 0;
  let upper = finalText.length;
  let best = buildOmpReplyMarkdownPost(input, TRUNCATION_MARKER, mentionMode);
  while (lower < upper) {
    let middle = codePointBoundary(finalText, Math.floor((lower + upper + 1) / 2));
    if (middle <= lower) middle = upper;
    const candidate = buildOmpReplyMarkdownPost(
      input,
      `${finalText.slice(0, middle)}${TRUNCATION_MARKER}`,
      mentionMode,
    );
    if (withinPostBudget(candidate)) {
      lower = middle;
      best = candidate;
    } else {
      upper = previousCodePointBoundary(finalText, middle);
    }
  }
  return best;
}

function buildOmpReplyMarkdownPost(
  input: ReplyInput,
  finalText: string,
  mentionMode: ReplyMentionMode,
): object {
  if (!isImReplyPlan(input)) {
    return markdownPost(buildOmpReplyMarkdown(input, finalText, mentionMode));
  }
  const activation = input.invocationKind === 'ordinary' ? input.peerActivation : undefined;
  if (activation) {
    if (mentionMode === 'plain') {
      return markdownPost(renderedOmpReplyMarkdown(input, mentionMode).markdown);
    }
    const owner =
      input.senderOwnership.kind === 'mention'
        ? [[{ tag: 'at', user_id: input.senderOwnership.openId }]]
        : [];
    const rendered = renderedOmpReplyMarkdown(input, 'omit');
    const markdown = rendered.markdown;
    const renderedInput = rendered.input;
    const renderedActivation =
      isImReplyPlan(renderedInput) && renderedInput.invocationKind === 'ordinary'
        ? renderedInput.peerActivation
        : undefined;
    if (renderedActivation && isImReplyPlan(renderedInput)) {
      const body = sanitizeImAnswer(ompReplyPresentation(renderedInput.state).finalReply);
      const before = maskEmails(`**回复**\n\n${body.slice(0, renderedActivation.start)}`);
      const matched = maskEmails(body.slice(renderedActivation.start, renderedActivation.end));
      if (
        markdown.startsWith(before) &&
        markdown.slice(before.length, before.length + matched.length) === matched
      ) {
        const peerRow = [
          ...(before ? [{ tag: 'md', text: before }] : []),
          { tag: 'at', user_id: renderedActivation.openId },
          ...(markdown.length > before.length + matched.length
            ? [{ tag: 'md', text: markdown.slice(before.length + matched.length) }]
            : []),
        ];
        return { zh_cn: { title: '', content: [...owner, peerRow] } };
      }
      if (owner.length > 0) {
        return {
          zh_cn: {
            title: '',
            content: [...owner, [{ tag: 'md', text: markdown }]],
          },
        };
      }
    }
  }
  if (mentionMode === 'plain') {
    return markdownPost(buildOmpReplyMarkdown(input, finalText, mentionMode));
  }
  const targetOpenIds = substitutionMentionOpenIds(input);
  const content: object[][] = [];
  if (input.senderOwnership.kind === 'mention') {
    content.push([{ tag: 'at', user_id: input.senderOwnership.openId }]);
  }
  if (targetOpenIds.length > 0) {
    const disclosure: object[] = [{ tag: 'text', text: 'AI 代 ' }];
    targetOpenIds.forEach((openId, index) => {
      if (index > 0) disclosure.push({ tag: 'text', text: '、' });
      disclosure.push({ tag: 'at', user_id: openId });
    });
    disclosure.push({ tag: 'text', text: ' 回答（已在本回复中点名）' });
    content.push(disclosure);
    if (input.invocationKind === 'substitution' && input.invalidTargetCount > 0) {
      content.push([
        {
          tag: 'text',
          text: `另有 ${input.invalidTargetCount} 个对象身份无法确认，未代答。`,
        },
      ]);
    }
    content.push([{ tag: 'text', text: '' }]);
  }
  if (content.length === 0) {
    return markdownPost(buildOmpReplyMarkdown(input, finalText, mentionMode));
  }
  content.push([{ tag: 'md', text: buildOmpReplyMarkdown(input, finalText, 'omit') }]);
  return { zh_cn: { title: '', content } };
}

function withinPostBudget(post: object): boolean {
  return Buffer.byteLength(JSON.stringify(post)) <= MAX_CARD_BYTES;
}

function withinMarkdownBudget(markdown: string): boolean {
  return Buffer.byteLength(JSON.stringify(markdownPost(markdown))) <= MAX_CARD_BYTES;
}

function withinPeerMarkdownBudget(markdown: string): boolean {
  return Buffer.byteLength(JSON.stringify(markdown)) <= MAX_CARD_BYTES - 512;
}

function markdownPost(markdown: string): object {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: markdown }]],
    },
  };
}

function buildOmpReplyMarkdown(
  input: ReplyInput,
  finalText: string,
  mentionMode?: ReplyMentionMode,
): string {
  const state = replyState(input);
  const presentation = ompReplyPresentation(state);
  const metrics = metricParts(state).join(' · ');
  return maskEmails(
    `**回复**\n\n${withSenderOwnership(input, finalText, mentionMode)}\n\n_状态: ${presentation.statusLabel}_${metrics ? `\n\n_${metrics}_` : ''}`,
  );
}

function metricsElements(state: RunState): object[] {
  const content = metricParts(state).join(' · ');
  return content
    ? [
        {
          tag: 'markdown',
          element_id: 'metrics',
          content: `<font color='grey'>${content}</font>`,
          text_size: 'notation',
        },
      ]
    : [];
}

function metricParts(state: RunState): string[] {
  const metrics = state.metrics;
  const terminal = state.terminal !== 'running';
  const contextPercent = validPercent(metrics.contextPercent);
  const outputDurationMs =
    terminal &&
    metrics.outputTimingComplete === true &&
    metrics.outputDurationMs !== undefined &&
    Number.isFinite(metrics.outputDurationMs) &&
    metrics.outputDurationMs > 0
      ? metrics.outputDurationMs
      : undefined;
  const tps =
    metrics.outputTokens !== undefined &&
    Number.isFinite(metrics.outputTokens) &&
    metrics.outputTokens > 0 &&
    outputDurationMs !== undefined
      ? metrics.outputTokens / (outputDurationMs / 1000)
      : undefined;
  return [
    metrics.modelId,
    metrics.effort ? `effort ${metrics.effort}` : undefined,
    contextPercent !== undefined ? `ctx ${formatPercent(contextPercent)}%` : undefined,
    terminal ? formatInterval('总耗时', metrics.receivedAtMono, metrics.terminalAtMono) : undefined,
    terminal && metrics.inputTokens !== undefined
      ? `输入 ${formatTokens(metrics.inputTokens)}`
      : undefined,
    terminal && metrics.outputTokens !== undefined
      ? `输出 ${formatTokens(metrics.outputTokens)}`
      : undefined,
    tps !== undefined ? `TPS ${tps.toFixed(1)}` : undefined,
  ].filter((part): part is string => part !== undefined);
}

function validPercent(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(100, value)
    : undefined;
}

function formatPercent(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatInterval(
  label: string,
  start: number | undefined,
  end: number | undefined,
): string | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return `${label} ${formatDuration(end - start)}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

function disclosure(
  elementId: string,
  title: string,
  expanded: boolean,
  elements: object[],
): object {
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    expanded,
    header: {
      title: { tag: 'plain_text', content: title },
      width: 'fill',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements,
  };
}

function placeholder(content: string): object {
  return {
    tag: 'markdown',
    content: `<font color='grey'>${content}</font>`,
    text_size: 'notation',
  };
}

const TOOL_STATUS_PRESENTATION: Record<ToolStatus, Readonly<{ icon: string; label: string }>> = {
  error: { icon: '⚠️', label: '失败' },
  done: { icon: '✓', label: '完成' },
  unfinished: { icon: '◼', label: '未完成' },
  running: { icon: '⏳', label: '运行中' },
};

function toolRow(tool: ToolEntry): string {
  const status = TOOL_STATUS_PRESENTATION[tool.status];
  return `- ${status.icon} **${escapeMarkdown(tool.name)}** · ${escapeMarkdown(tool.action)} · ${status.label}`;
}
function replyState(input: ReplyInput): RunState {
  return isImReplyPlan(input) ? input.state : input;
}

function isImReplyPlan(input: ReplyInput): input is ImReplyPlan {
  return 'senderOwnership' in input;
}

function withSenderOwnership(
  input: ReplyInput,
  body: string,
  mentionMode: ReplyMentionMode = 'mention',
): string {
  const safeBody = isImReplyPlan(input) ? sanitizeImAnswer(body) : body;
  const ownedBody = withPeerActivation(input, safeBody, mentionMode);
  if (!isImReplyPlan(input) || mentionMode === 'omit') return ownedBody;

  const prefix: string[] = [];
  if (input.senderOwnership.kind === 'mention') {
    prefix.push(
      mentionMode === 'plain'
        ? '\\@请求者'
        : `<at id="${escapeAttribute(input.senderOwnership.openId)}"></at>`,
    );
  }
  const targetOpenIds = substitutionMentionOpenIds(input);
  if (targetOpenIds.length > 0 && input.invocationKind === 'substitution') {
    const targets = targetOpenIds.map((targetOpenId, index) =>
      mentionMode === 'plain'
        ? `\\@${escapeMarkdown(input.substitutionTargetLabels[index] ?? '目标')}`
        : `<at id="${escapeAttribute(targetOpenId)}"></at>`,
    );
    prefix.push(`AI 代 ${targets.join('、')} 回答（已在本回复中点名）`);
    if (input.invalidTargetCount > 0) {
      prefix.push(`另有 ${input.invalidTargetCount} 个对象身份无法确认，未代答。`);
    }
  }
  if (prefix.length === 0) return ownedBody;
  if (mentionMode === 'plain') {
    prefix.push('<font color="grey">Mention 不可用，已改为文本归属</font>');
  }
  return `${prefix.join('\n')}\n\n${ownedBody}`;
}

function withPeerActivation(
  input: ReplyInput,
  body: string,
  mentionMode: ReplyMentionMode,
): string {
  if (
    !isImReplyPlan(input) ||
    input.invocationKind !== 'ordinary' ||
    !input.peerActivation ||
    mentionMode === 'omit'
  ) {
    return body;
  }
  const { alias, openId, start, end } = input.peerActivation;
  if (start < 0 || end <= start || end > body.length) return body;
  const mention =
    mentionMode === 'plain'
      ? `\\@${escapeMarkdown(alias)}`
      : `<at id="${escapeAttribute(openId)}">@${alias}</at>`;
  const rendered = `${body.slice(0, start)}${mention}${body.slice(end)}`;
  return mentionMode === 'plain'
    ? `${rendered}\n\n<font color="grey">Peer 未通知：Mention 不可用</font>`
    : rendered;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}


export function ompReplyPresentation(state: RunState): OmpReplyPresentation {
  const statusLabel =
    state.terminal === 'done'
      ? '已完成'
      : state.terminal === 'interrupted'
        ? '已中断'
        : state.terminal === 'idle_timeout'
          ? '已超时'
          : state.terminal === 'error'
            ? '失败'
            : '运行中';
  const finalReply =
    state.terminal === 'done'
      ? state.finalText?.trim() || '未返回内容'
      : state.terminal === 'interrupted'
        ? '运行已中断。'
        : state.terminal === 'idle_timeout'
          ? '运行已超时。'
          : state.terminal === 'error'
            ? '运行失败。'
            : '';
  const summary =
    state.terminal !== 'running'
      ? statusLabel
      : state.footer === 'tool_running'
        ? '正在调用工具'
        : state.footer === 'streaming'
          ? '正在输出'
          : '思考中';
  return { finalReply, statusLabel, summary };
}

function escapeMarkdown(value: string): string {
  return sanitizeImAnswer(value).replace(/([\\`*_{}[\]()#+.!\-|>])/g, '\\$1');
}

