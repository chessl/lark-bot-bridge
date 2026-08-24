import { deepMaskEmails, maskEmails } from './mask-email';
import type { RunState, ToolEntry, ToolStatus } from './run-state';

const MAX_CARD_BYTES = 30 * 1024;
const MAX_CARD_ELEMENTS = 200;
const TRUNCATION_MARKER = '内容过长，已截断';

type RenderOptions = Readonly<{
  streamingMode: boolean;
  toolCount?: number | null;
}>;

type OmpReplyPresentation = Readonly<{
  finalReply: string;
  statusLabel: string;
  summary: string;
}>;

export function renderOmpReplyCard(state: RunState, options?: RenderOptions): object {
  let reasoning = state.reasoningEntries ?? [];
  let tools = state.tools;
  const finalText = ompReplyPresentation(state).finalReply;
  let card = buildOmpReplyCard(state, reasoning, tools, finalText, options);

  while (!withinCardBudget(card) && reasoning.length > 0) {
    reasoning = reasoning.slice(1);
    card = buildOmpReplyCard(state, reasoning, tools, finalText, options);
  }
  while (!withinCardBudget(card) && tools.length > 0) {
    tools = tools.slice(1);
    card = buildOmpReplyCard(state, reasoning, tools, finalText, options);
  }
  if (!withinCardBudget(card) && state.terminal === 'done') {
    card = truncateFinalReply(state, reasoning, tools, finalText, options);
  }
  return card;
}

function buildOmpReplyCard(
  state: RunState,
  reasoning: readonly string[],
  tools: readonly ToolEntry[],
  finalText: string,
  options: RenderOptions | undefined,
): object {
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
            : finalText,
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
  state: RunState,
  reasoning: readonly string[],
  tools: readonly ToolEntry[],
  finalText: string,
  options: RenderOptions | undefined,
): object {
  let lower = 0;
  let upper = finalText.length;
  let best = buildOmpReplyCard(state, reasoning, tools, TRUNCATION_MARKER, options);

  while (lower < upper) {
    let middle = codePointBoundary(finalText, Math.floor((lower + upper + 1) / 2));
    if (middle <= lower) middle = upper;
    const candidate = buildOmpReplyCard(
      state,
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

export function renderOmpReplyMarkdown(state: RunState): string {
  if (state.terminal === 'running') {
    throw new Error('cannot render a running OMP Reply as terminal Markdown');
  }
  const finalText = ompReplyPresentation(state).finalReply;
  const full = buildOmpReplyMarkdown(state, finalText);
  if (withinMarkdownBudget(full) || state.terminal !== 'done') return full;

  let lower = 0;
  let upper = finalText.length;
  let best = buildOmpReplyMarkdown(state, TRUNCATION_MARKER);
  while (lower < upper) {
    let middle = codePointBoundary(finalText, Math.floor((lower + upper + 1) / 2));
    if (middle <= lower) middle = upper;
    const candidate = buildOmpReplyMarkdown(
      state,
      `${finalText.slice(0, middle)}${TRUNCATION_MARKER}`,
    );
    if (withinMarkdownBudget(candidate)) {
      lower = middle;
      best = candidate;
    } else {
      upper = previousCodePointBoundary(finalText, middle);
    }
  }
  return best;
}

export function renderOmpReplyMarkdownPost(state: RunState): object {
  return markdownPost(renderOmpReplyMarkdown(state));
}

function withinMarkdownBudget(markdown: string): boolean {
  return Buffer.byteLength(JSON.stringify(markdownPost(markdown))) <= MAX_CARD_BYTES;
}

function markdownPost(markdown: string): object {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: markdown }]],
    },
  };
}

function buildOmpReplyMarkdown(state: RunState, finalText: string): string {
  const presentation = ompReplyPresentation(state);
  const metrics = metricParts(state).join(' · ');
  return maskEmails(
    `**回复**\n\n${finalText}\n\n_状态: ${presentation.statusLabel}_${metrics ? `\n\n_${metrics}_` : ''}`,
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
  return `- ${status.icon} **${escapeMarkdown(tool.name)}** · ${tool.action} · ${status.label}`;
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
  return value.replace(/([\\`*_{}[\]()#+.!\-|>])/g, '\\$1');
}
