// THROWAWAY PROTOTYPE: live CardKit validation for the unified OMP Reply design.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { resolveAppSecret } from '../config/secret-resolver';
import { resolveProfileRuntime } from '../runtime/profile-runtime';

type TerminalStatus = 'done' | 'interrupted' | 'idle_timeout' | 'error';
type RunStatus = 'running' | TerminalStatus;

interface ToolRow {
  id: number;
  name: string;
  action: string;
  status: '运行中' | '完成' | '失败';
}

interface Metrics {
  total?: string;
  arrival?: string;
  prelude?: string;
  firstText?: string;
  omp?: string;
  input?: string;
  output?: string;
  tools?: number;
}
interface RuntimeDetails {
  model?: string;
  effort?: string;
  contextUsed?: number;
  contextWindow?: number;
}


interface PrototypeState {
  status: RunStatus;
  pendingAssistant?: string;
  finalAnswer?: string;
  progress: string[];
  progressTotal: number;
  tools: ToolRow[];
  toolTotal: number;
  lifecycle: string[];
  metrics: Metrics;
  runtime: RuntimeDetails;
}

interface Args {
  profile?: string;
  messageId?: string;
  closeCardId?: string;
  replyInThread: boolean;
}

const MAX_PROGRESS = 12;
const MAX_TOOLS = 20;
const toolKinds = [
  ['读取文件', '读取'],
  ['搜索代码', '搜索'],
  ['运行命令', '执行'],
  ['修改文件', '修改'],
] as const;

const args = parseArgs(process.argv.slice(2));
const runtime = await resolveProfileRuntime({
  profile: args.profile,
  allowBootstrap: false,
});
const appSecret = await resolveAppSecret(runtime.cfg, runtime.appPaths);
const channel = createLarkChannel({
  appId: runtime.cfg.accounts.app.id,
  appSecret,
  domain:
    runtime.cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn',
  source: 'unified-reply-prototype',
  loggerLevel: 'error',
});
if (args.closeCardId) {
  const interrupted: PrototypeState = {
    status: 'interrupted',
    finalAnswer: '原型探针异常退出；卡片已安全收口。',
    progress: [],
    progressTotal: 0,
    tools: [],
    toolTotal: 0,
    lifecycle: [],
    metrics: {},
    runtime: {},
  };
  await channel.updateCardById(args.closeCardId, renderCard(interrupted), 1);
  await closeStreaming(channel, args.closeCardId, interrupted, 2);
  process.exit(0);
}
if (!args.messageId) throw new Error('missing --message');


const target = await inspectTarget(channel, args.messageId);
const state: PrototypeState = {
  status: 'running',
  progress: [],
  progressTotal: 0,
  tools: [],
  toolTotal: 0,
  lifecycle: [],
  metrics: { total: '0.8s' },
  runtime: {},
};
let sequence = 1;
const replyUuid = randomUUID();
const initialCard = renderCard(state);
const { cardId } = await channel.createCard(initialCard);
const replyPayload = {
  path: { message_id: args.messageId },
  data: {
    msg_type: 'interactive',
    content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
    reply_in_thread: args.replyInThread,
    uuid: replyUuid,
  },
};
const replied = await channel.rawClient.im.v1.message.reply(replyPayload);
const messageId = replied.data?.message_id;
if (!messageId) throw new Error('IM Reply returned no message_id');

print('opened', {
  profile: runtime.profile,
  target,
  replyInThread: args.replyInThread,
  cardId,
  messageId,
  replyUuid,
  response: {
    rootId: replied.data?.root_id,
    parentId: replied.data?.parent_id,
    threadId: replied.data?.thread_id,
  },
});
printState(state, sequence);

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  while (true) {
    const command = (
      await rl.question(
        '\n[a] assistant结束 [t] 工具 [P] 13条思考 [T] 21次工具 [l] 生命周期 [m] 缺失统计\n' +
          '[g] DeepSeek实测 [r] Reply精确重试 [h] 历史消息恢复 [b] CardKit边界\n' +
          '[d/i/o/e] 四种终态 [x] 终态+关闭失败 [c] 收口 [q] 退出 > ',
      )
    ).trim();

    if (command === 'q') break;
    if (command === 'a') {
      state.pendingAssistant = `已完成阶段 ${state.progressTotal + 1}，正在等待后续事件确认归类。`;
      print('pending-assistant-hidden', { pendingAssistant: state.pendingAssistant });
      printState(state, sequence);
      continue;
    }
    if (command === 't') {
      flushPendingAsProgress(state);
      addTool(state);
      await project(channel, cardId, state, sequence++);
    } else if (command === 'P') {
      for (let index = 0; index < 13; index++) addProgress(state, `已完成安全进度 ${index + 1}`);
      await project(channel, cardId, state, sequence++);
    } else if (command === 'T') {
      for (let index = 0; index < 21; index++) addTool(state);
      await project(channel, cardId, state, sequence++);
    } else if (command === 'l') {
      cycleLifecycle(state);
      await project(channel, cardId, state, sequence++);
    } else if (command === 'm') {
      state.metrics = { total: '18.4s', tools: state.toolTotal };
      await project(channel, cardId, state, sequence++);
    } else if (command === 'g') {
      applyDeepSeekProbe(state);
      await project(channel, cardId, state, sequence++);
      await closeStreaming(channel, cardId, state, sequence++);
    } else if (command === 'r') {
      try {
        const retried = await channel.rawClient.im.v1.message.reply(replyPayload);
        print('exact-reply-retry', {
          originalMessageId: messageId,
          retryMessageId: retried.data?.message_id,
          sameBubble: retried.data?.message_id === messageId,
        });
      } catch (error) {
        print('exact-reply-retry', {
          originalMessageId: messageId,
          sameBubble: 'one bubble observed; retry rejected',
          error: errorMessage(error),
        });
      }
    } else if (command === 'h') {
      try {
        await inspectHistoryRecovery(
          channel,
          replied.data?.thread_id ?? target.threadId,
          target.chatId,
          args.messageId,
          messageId,
          cardId,
        );
      } catch (error) {
        print('history-recovery-failed', { error: errorMessage(error) });
      }
    } else if (command === 'b') {
      await checkBounds(channel);
    } else if (command === 'd' || command === 'i' || command === 'o' || command === 'e') {
      const status: TerminalStatus =
        command === 'd'
          ? 'done'
          : command === 'i'
            ? 'interrupted'
            : command === 'o'
              ? 'idle_timeout'
              : 'error';
      finishState(state, status);
      await project(channel, cardId, state, sequence++);
      await closeStreaming(channel, cardId, state, sequence++);
    } else if (command === 'x') {
      finishState(state, 'done');
      const terminalSequence = sequence++;
      await project(channel, cardId, state, terminalSequence);
      await closeWithInvalidSettings(channel, cardId, sequence);
    } else if (command === 'c') {
      await closeStreaming(channel, cardId, state, sequence++);
    } else {
      print('unknown-command', { command });
      continue;
    }
    printState(state, sequence);
  }
} finally {
  rl.close();
}

function parseArgs(argv: string[]): Args {
  let profile: string | undefined;
  let messageId: string | undefined;
  let closeCardId: string | undefined;
  let replyInThread = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--profile') profile = argv[++index];
    else if (arg === '--message') messageId = argv[++index];
    else if (arg === '--close-card') closeCardId = argv[++index];
    else if (arg === '--reply-in-thread') replyInThread = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!messageId && !closeCardId) {
    throw new Error(
      'usage: pnpm prototype:reply -- --profile <name> (--message <om_xxx> [--reply-in-thread] | --close-card <card_id>)',
    );
  }
  return {
    ...(profile ? { profile } : {}),
    ...(messageId ? { messageId } : {}),
    ...(closeCardId ? { closeCardId } : {}),
    replyInThread,
  };
}

async function inspectTarget(targetChannel: LarkChannel, targetMessageId: string) {
  const items = (
    await targetChannel.rawClient.im.v1.message.get({ path: { message_id: targetMessageId } })
  ).data?.items;
  const item = items?.[0];
  if (!item?.chat_id) throw new Error(`target message not found: ${targetMessageId}`);
  return {
    messageId: targetMessageId,
    chatId: item.chat_id,
    chatMode: await targetChannel.getChatMode(item.chat_id),
    rootId: item.root_id,
    parentId: item.parent_id,
    threadId: item.thread_id,
  };
}

function flushPendingAsProgress(current: PrototypeState): void {
  if (!current.pendingAssistant) return;
  addProgress(current, current.pendingAssistant);
  current.pendingAssistant = undefined;
}

function addProgress(current: PrototypeState, text: string): void {
  current.progressTotal++;
  current.progress.push(text.slice(0, 600));
  current.progress = current.progress.slice(-MAX_PROGRESS);
}

function addTool(current: PrototypeState): void {
  const id = ++current.toolTotal;
  const [name, action] = toolKinds[(id - 1) % toolKinds.length] ?? toolKinds[0];
  current.tools.push({ id, name, action, status: id % 7 === 0 ? '失败' : '完成' });
  current.tools = current.tools.slice(-MAX_TOOLS);
}

function cycleLifecycle(current: PrototypeState): void {
  const active = current.lifecycle.at(-1);
  if (!active) current.lifecycle.push('等待重试（2/3，1.5s）');
  else if (active.startsWith('等待重试')) current.lifecycle.push('正在切换备用模型');
  else if (active === '正在切换备用模型') current.lifecycle.push('正在整理上下文');
  else current.lifecycle.pop();
}

function finishState(current: PrototypeState, status: TerminalStatus): void {
  current.status = status;
  current.lifecycle = [];
  current.finalAnswer =
    status === 'done'
      ? (current.pendingAssistant ?? '原型运行完成：Final Reply 已在同一气泡中落定。')
      : status === 'interrupted'
        ? '运行已中断；已保留最后成功投影。'
        : status === 'idle_timeout'
          ? '运行因长时间无事件而超时。'
          : '运行失败；未展示任何原始错误内容。';
  current.pendingAssistant = undefined;
  current.metrics = {
    total: '42.3s',
    arrival: '≈0.8s',
    prelude: '2.1s',
    firstText: '5.7s',
    omp: '39.4s',
    input: '12.4k',
    output: '2.1k',
    tools: current.toolTotal,
  };
}
function applyDeepSeekProbe(current: PrototypeState): void {
  current.status = 'done';
  current.pendingAssistant = undefined;
  current.lifecycle = [];
  current.progress = [
    'The user asks for a brief reasoning step and then the exact arithmetic answer. This is a simple addition, so comply directly.',
  ];
  current.progressTotal = 1;
  current.finalAnswer = '2+2=4';
  current.runtime = {
    model: 'deepseek-v4-flash',
    effort: 'high',
    contextUsed: 5_359,
    contextWindow: 1_000_000,
  };
  current.metrics = {
    total: '4.96s',
    input: '5.3k',
    output: '75',
    tools: current.toolTotal,
  };
}


async function project(
  targetChannel: LarkChannel,
  targetCardId: string,
  current: PrototypeState,
  currentSequence: number,
): Promise<void> {
  await targetChannel.updateCardById(targetCardId, renderCard(current), currentSequence);
  print('projected', { sequence: currentSequence, status: current.status });
}

async function inspectHistoryRecovery(
  targetChannel: LarkChannel,
  threadId: string | undefined,
  chatId: string,
  targetMessageId: string,
  knownMessageId: string,
  targetCardId: string,
): Promise<void> {
  const containerIdType = threadId ? 'thread' : 'chat';
  const containerId = threadId ?? chatId;
  const listed = await targetChannel.rawClient.im.v1.message.list({
    params: {
      container_id_type: containerIdType,
      container_id: containerId,
      sort_type: 'ByCreateTimeDesc',
      page_size: 50,
      card_msg_content_type: 'user_card_content',
    },
  });
  if (listed.code !== undefined && listed.code !== 0) {
    throw new Error(`IM history failed: code=${listed.code} msg=${listed.msg ?? '<none>'}`);
  }
  const candidates = (listed.data?.items ?? [])
    .filter((item) => {
      const content = item.body?.content ?? '';
      return (
        item.message_id === knownMessageId ||
        item.parent_id === targetMessageId ||
        content.includes(targetCardId)
      );
    })
    .map((item) => ({
      messageId: item.message_id,
      rootId: item.root_id,
      parentId: item.parent_id,
      threadId: item.thread_id,
      messageType: item.msg_type,
      createTime: item.create_time,
      senderType: item.sender?.sender_type,
      matchesTargetParent: item.parent_id === targetMessageId,
      containsCardId: (item.body?.content ?? '').includes(targetCardId),
    }));
  print('history-recovery', {
    containerIdType,
    containerId,
    knownMessageFound: candidates.some((item) => item.messageId === knownMessageId),
    candidates,
  });
}

async function closeStreaming(
  targetChannel: LarkChannel,
  targetCardId: string,
  current: PrototypeState,
  currentSequence: number,
): Promise<void> {
  const result = await targetChannel.rawClient.cardkit.v1.card.settings({
    path: { card_id: targetCardId },
    data: {
      settings: JSON.stringify({
        streaming_mode: false,
        summary: { content: summaryFor(current.status) },
      }),
      sequence: currentSequence,
      uuid: `close-${currentSequence}-${targetCardId}`.slice(0, 64),
    },
  });
  if (result.code !== undefined && result.code !== 0) {
    throw new Error(`CardKit settings failed: code=${result.code} msg=${result.msg ?? '<none>'}`);
  }
  print('streaming-closed', { sequence: currentSequence });
}

async function closeWithInvalidSettings(
  targetChannel: LarkChannel,
  targetCardId: string,
  currentSequence: number,
): Promise<void> {
  try {
    const result = await targetChannel.rawClient.cardkit.v1.card.settings({
      path: { card_id: targetCardId },
      data: {
        settings: '{',
        sequence: currentSequence,
        uuid: `invalid-close-${currentSequence}-${targetCardId}`.slice(0, 64),
      },
    });
    if (result.code !== undefined && result.code !== 0) {
      print('injected-close-failure', {
        currentSequence,
        error: JSON.stringify({ code: result.code, message: result.msg }),
      });
      return;
    }
    print('unexpected-invalid-close-success', { currentSequence });
  } catch (error) {
    print('injected-close-failure', { currentSequence, error: errorMessage(error) });
  }
}

function renderCard(current: PrototypeState): object {
  const terminal = current.status !== 'running';
  const visibleReasoning = current.progress
    .map((line, index) => `${index + 1}. ${escapeMarkdown(line)}`)
    .join('\n');
  const visibleTools = current.tools
    .map(
      (tool) =>
        `${tool.status === '失败' ? '⚠️' : '✓'} **${tool.name}** · ${tool.action} · ${tool.status}`,
    )
    .join('\n');
  const metrics = metricParts(current.metrics);
  const runtime = runtimeParts(current.runtime);
  const lifecycle = current.lifecycle.at(-1);
  const template =
    current.status === 'done' ? 'green' : current.status === 'running' ? 'blue' : 'red';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: true,
      summary: { content: summaryFor(current.status) },
      style: {
        text_size: {
          body: { default: 'normal', pc: 'normal', mobile: 'normal' },
          caption: { default: 'notation', pc: 'notation', mobile: 'notation' },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: terminal ? 'OMP Reply' : 'OMP 正在处理' },
      subtitle: {
        tag: 'plain_text',
        content: lifecycle ?? statusLabel(current.status),
      },
      template,
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: statusLabel(current.status) },
          color: current.status === 'done' ? 'green' : current.status === 'running' ? 'blue' : 'red',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          element_id: 'answer',
          content: terminal
            ? `**${escapeMarkdown(current.finalAnswer ?? statusLabel(current.status))}**`
            : '**正在完成请求**\n<font color=\'grey\'>Final Reply 会在确认后原位出现。</font>',
          text_size: 'body',
        },
        activityPanel(
          'reasoning',
          `Reasoning ${current.progress.length}/${current.progressTotal}`,
          !terminal,
          visibleReasoning || "<font color='grey'>等待 Reasoning…</font>",
        ),
        activityPanel(
          'tools',
          `Tools ${current.tools.length}/${current.toolTotal}`,
          !terminal,
          visibleTools || "<font color='grey'>尚未调用工具</font>",
        ),
        { tag: 'hr' },
        ...(runtime.length
          ? [
              {
                tag: 'markdown',
                element_id: 'runtime',
                content: `<font color='grey'>${runtime.join(' · ')}</font>`,
                text_size: 'caption',
              },
            ]
          : []),
        {
          tag: 'markdown',
          element_id: 'metrics',
          content: metrics.length
            ? `<font color='grey'>${metrics.join(' · ')}</font>`
            : "<font color='grey'>运行统计暂不可得</font>",
          text_size: 'caption',
        },
      ],
    },
  };
}

function activityPanel(
  elementId: string,
  title: string,
  expanded: boolean,
  content: string,
): object {
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    expanded,
    background_color: 'grey',
    header: {
      title: { tag: 'plain_text', content: title },
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '8px' },
    padding: '8px',
    vertical_spacing: '8px',
    elements: [{ tag: 'markdown', content, text_size: 'notation' }],
  };
}

function runtimeParts(details: RuntimeDetails): string[] {
  const percent =
    details.contextUsed !== undefined &&
    details.contextWindow !== undefined &&
    details.contextWindow > 0
      ? Math.min(100, (details.contextUsed * 100) / details.contextWindow)
      : undefined;
  return [
    details.model,
    details.effort ? `effort ${details.effort}` : undefined,
    percent !== undefined ? `ctx ${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%` : undefined,
  ].filter((part): part is string => part !== undefined);
}

function metricParts(metrics: Metrics): string[] {
  return [
    metrics.total ? `总耗时 ${metrics.total}` : undefined,
    metrics.arrival ? `飞书到达 ${metrics.arrival}` : undefined,
    metrics.prelude ? `前置 ${metrics.prelude}` : undefined,
    metrics.firstText ? `首字 ${metrics.firstText}` : undefined,
    metrics.omp ? `OMP ${metrics.omp}` : undefined,
    metrics.input ? `输入 ${metrics.input}` : undefined,
    metrics.output ? `输出 ${metrics.output}` : undefined,
    metrics.tools !== undefined ? `工具 ${metrics.tools}` : undefined,
  ].filter((part): part is string => part !== undefined);
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'done':
      return '完成';
    case 'interrupted':
      return '中断';
    case 'idle_timeout':
      return '超时';
    case 'error':
      return '失败';
  }
}

function summaryFor(status: RunStatus): string {
  return status === 'running' ? 'OMP 正在处理' : `OMP ${statusLabel(status)}`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '&#42;').replaceAll('<', '&#60;');
}

async function checkBounds(targetChannel: LarkChannel): Promise<void> {
  for (const [label, card] of [
    ['198-body-elements', elementBoundaryCard(198)],
    ['199-body-elements', elementBoundaryCard(199)],
    ['200-body-elements', elementBoundaryCard(200)],
    ['201-body-elements', elementBoundaryCard(201)],
    ['near-30kb', byteBoundaryCard(29 * 1024)],
    ['over-30kb', byteBoundaryCard(31 * 1024)],
  ] as const) {
    const bytes = Buffer.byteLength(JSON.stringify(card));
    try {
      const result = await targetChannel.createCard(card);
      print('boundary-result', { label, bytes, ok: true, cardId: result.cardId });
    } catch (error) {
      print('boundary-result', { label, bytes, ok: false, error: errorMessage(error) });
    }
  }
}

function elementBoundaryCard(count: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: `元素边界 ${count}` } },
    header: { title: { tag: 'plain_text', content: `元素边界 ${count}` }, template: 'blue' },
    body: {
      elements: Array.from({ length: count }, (_, index) => ({
        tag: 'markdown',
        element_id: `e${index}`,
        content: `${index + 1}`,
      })),
    },
  };
}

function byteBoundaryCard(targetBytes: number): object {
  const card = {
    schema: '2.0',
    config: { summary: { content: '字节边界' } },
    header: { title: { tag: 'plain_text', content: '字节边界' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', element_id: 'payload', content: '' }] },
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(card));
  card.body.elements[0].content = 'x'.repeat(Math.max(0, targetBytes - baseBytes));
  return card;
}

function printState(current: PrototypeState, nextSequence: number): void {
  print('state', { nextSequence, ...current });
}

function print(event: string, value: unknown): void {
  process.stdout.write(`${event}: ${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null) {
        const code = 'code' in data ? data.code : undefined;
        const message = 'msg' in data ? data.msg : undefined;
        const detail = 'error' in data ? data.error : undefined;
        const logId =
          typeof detail === 'object' && detail !== null && 'log_id' in detail
            ? detail.log_id
            : undefined;
        return JSON.stringify({ code, message, logId });
      }
    }
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    const message = error instanceof Error ? error.message : undefined;
    return JSON.stringify({ code, message });
  }
  return error instanceof Error ? error.name : typeof error;
}
