import { deepMaskEmails } from './mask-email';
import type { RunState, ToolEntry } from './run-state';

export function renderOmpReplyCard(state: RunState): object {
  const running = state.terminal === 'running';
  const reasoning = state.reasoningEntries ?? [];
  const tools = state.blocks.flatMap((block) => (block.kind === 'tool' ? [block.tool] : []));
  const activity = state.activityStack?.at(-1)?.label;

  return deepMaskEmails({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: running,
      summary: { content: summaryFor(state) },
    },
    header: {
      title: { tag: 'plain_text', content: running ? 'OMP 正在处理' : 'OMP Reply' },
      subtitle: { tag: 'plain_text', content: activity ?? statusLabel(state) },
      template: state.terminal === 'done' ? 'green' : running ? 'blue' : 'red',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: statusLabel(state) },
          color: state.terminal === 'done' ? 'green' : running ? 'blue' : 'red',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        disclosure(
          'reasoning',
          `💭 中间过程（${state.reasoningTotal ?? reasoning.length} 条）`,
          running,
          reasoning.length > 0
            ? reasoning.flatMap((entry, index) => [
                ...(index > 0 ? [{ tag: 'hr' }] : []),
                { tag: 'markdown', content: escapeMarkdown(entry), text_size: 'body' },
              ])
            : [placeholder('等待思考过程…')],
        ),
        {
          tag: 'markdown',
          element_id: 'answer',
          content: running
            ? "**正在完成请求**\n<font color='grey'>Final Reply 会在确认后原位出现。</font>"
            : `**${finalReply(state)}**`,
          text_size: 'body',
        },
        ...metricsElements(state),
        disclosure(
          'tools',
          `🔧 调用工具 ${state.metrics.toolIds.length} 次`,
          running,
          [
            {
              tag: 'markdown',
              content:
                tools.length > 0
                  ? tools.map((tool) => toolRow(tool)).join('\n')
                  : "<font color='grey'>尚未调用工具</font>",
              text_size: 'notation',
            },
          ],
        ),
      ],
    },
  });
}

export function renderOmpReplyMarkdown(state: RunState): string {
  if (state.terminal === 'running') {
    throw new Error('cannot render a running OMP Reply as terminal Markdown');
  }
  const metrics = metricParts(state).join(' · ');
  return `**Final Reply**\n\n${finalReply(state)}\n\n_Run Termination: ${statusLabel(state)}_${metrics ? `\n\n_${metrics}_` : ''}`;
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
  const arrival =
    metrics.receivedAtWall !== undefined && metrics.messageCreatedAtWall !== undefined
      ? metrics.receivedAtWall - metrics.messageCreatedAtWall
      : undefined;
  return [
    metrics.modelId,
    metrics.effort ? `effort ${metrics.effort}` : undefined,
    contextPercent !== undefined ? `ctx ${formatPercent(contextPercent)}%` : undefined,
    terminal
      ? formatInterval('总耗时', metrics.receivedAtMono, metrics.terminalAtMono)
      : undefined,
    terminal && arrival !== undefined && arrival >= 0 && arrival <= 10 * 60_000
      ? `飞书到达 ≈${formatDuration(arrival)}`
      : undefined,
    terminal
      ? formatInterval('前置', metrics.receivedAtMono, metrics.promptSentAtMono)
      : undefined,
    terminal
      ? formatInterval('首字', metrics.promptSentAtMono, metrics.firstTextAtMono)
      : undefined,
    terminal
      ? formatInterval('OMP', metrics.promptSentAtMono, metrics.terminalAtMono)
      : undefined,
    terminal && metrics.inputTokens !== undefined
      ? `输入 ${formatTokens(metrics.inputTokens)}`
      : undefined,
    terminal && metrics.outputTokens !== undefined
      ? `输出 ${formatTokens(metrics.outputTokens)}`
      : undefined,
    terminal ? `工具 ${metrics.toolIds.length}` : undefined,
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

function disclosure(elementId: string, title: string, expanded: boolean, elements: object[]): object {
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

function toolRow(tool: ToolEntry): string {
  const icon =
    tool.status === 'error'
      ? '⚠️'
      : tool.status === 'done'
        ? '✓'
        : tool.status === 'unfinished'
          ? '◼'
          : '⏳';
  const status =
    tool.status === 'error'
      ? '失败'
      : tool.status === 'done'
        ? '完成'
        : tool.status === 'unfinished'
          ? '未完成'
          : '运行中';
  return `- ${icon} **${escapeMarkdown(tool.name)}** · ${tool.action ?? '执行'} · ${status}`;
}

function finalReply(state: RunState): string {
  if (state.terminal === 'done') return state.finalText?.trim() || '未返回内容';
  if (state.terminal === 'interrupted') return '运行已中断。';
  if (state.terminal === 'idle_timeout') return '运行已超时。';
  if (state.terminal === 'error') return '运行失败。';
  return '';
}

function statusLabel(state: RunState): string {
  if (state.terminal === 'done') return '已完成';
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '失败';
  return '运行中';
}

function summaryFor(state: RunState): string {
  const activity = state.activityStack?.at(-1);
  return activity?.label ?? statusLabel(state);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!\-|>])/g, '\\$1');
}
