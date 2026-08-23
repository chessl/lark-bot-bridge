import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';

const MAX_REASONING = 12;
const MAX_REASONING_CHARS = 600;
const MAX_TOOLS = 20;
const MAX_TOOL_LABEL_CHARS = 80;

export type ToolStatus = 'running' | 'done' | 'error' | 'unfinished';
export type ToolAction = '读取' | '搜索' | '执行' | '修改' | '协作';

export interface ToolEntry {
  id: string;
  name: string;
  action?: ToolAction;
  status: ToolStatus;
  /** Legacy callers may construct these fields; the OMP reducer never retains them. */
  input?: unknown;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';
export type LifecycleKind = 'retry' | 'fallback' | 'compaction';

export interface LifecycleActivity {
  kind: LifecycleKind;
  label: string;
}

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
  pendingAssistant?: string;
  assistantDraft?: string;
  reasoningEntries?: readonly string[];
  reasoningTotal?: number;
  activityStack?: readonly LifecycleActivity[];
  knownToolIds?: readonly string[];
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
  reasoningEntries: [],
  reasoningTotal: 0,
  activityStack: [],
  knownToolIds: [],
};

export function reduce(state: RunState, evt: AgentEvent): RunState {
  if (state.terminal !== 'running') {
    return ignoreEvent(
      state,
      evt,
      evt.type === 'done' || evt.type === 'error' ? 'duplicate-terminal' : 'post-terminal',
    );
  }

  switch (evt.type) {
    case 'text':
      return {
        ...state,
        assistantDraft: `${state.assistantDraft ?? ''}${evt.delta}`,
        footer: 'streaming',
      };

    case 'final_text': {
      const committed = commitPendingAsReasoning(state);
      return {
        ...committed,
        assistantDraft: undefined,
        pendingAssistant: evt.content,
        footer: 'streaming',
      };
    }

    case 'reasoning':
      return addReasoning(state, evt.content);

    case 'thinking':
      return state;

    case 'tool_use':
      return upsertTool(commitPendingAsReasoning(completeDraft(state)), evt.id, evt.name);

    case 'tool_result':
      return finishTool(state, evt.id, evt.isError);

    case 'retry_start':
      return pushActivity(state, {
        kind: 'retry',
        label: retryLabel(evt.attempt, evt.maxAttempts, evt.delayMs),
      });

    case 'retry_end':
      return popActivity(state, 'retry');

    case 'fallback_start':
      return pushActivity(state, { kind: 'fallback', label: '正在切换备用模型' });

    case 'fallback_end':
      return popActivity(state, 'fallback');

    case 'compaction_start':
      return pushActivity(state, { kind: 'compaction', label: '正在整理上下文' });

    case 'compaction_end':
      return popActivity(state, 'compaction');

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return terminateAbnormally(state, terminal);
    }

    case 'done': {
      if (evt.terminationReason === 'interrupted') {
        return terminateAbnormally(state, 'interrupted');
      }
      if (evt.terminationReason === 'timeout') {
        return terminateAbnormally(state, 'idle_timeout');
      }
      return terminateNormally(state);
    }

    case 'system':
    case 'usage':
      return state;

    default: {
      const _exhaustive: never = evt;
      return ignoreEvent(state, _exhaustive, 'unknown');
    }
  }
}

export function markInterrupted(state: RunState): RunState {
  return state.terminal === 'running' ? terminateAbnormally(state, 'interrupted') : state;
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  if (state.terminal !== 'running') return state;
  return { ...terminateAbnormally(state, 'idle_timeout'), idleTimeoutMinutes: minutes };
}

export function finalizeIfRunning(state: RunState): RunState {
  return state.terminal === 'running' ? terminateNormally(state) : state;
}

function completeDraft(state: RunState): RunState {
  if (!state.assistantDraft) return state;
  return { ...state, assistantDraft: undefined, pendingAssistant: state.assistantDraft };
}

function commitPendingAsReasoning(state: RunState): RunState {
  return state.pendingAssistant
    ? addReasoning({ ...state, pendingAssistant: undefined }, state.pendingAssistant)
    : state;
}

function addReasoning(state: RunState, content: string): RunState {
  const entry = boundLabel(content, MAX_REASONING_CHARS);
  if (!entry) return state;
  const entries = [...(state.reasoningEntries ?? []), entry].slice(-MAX_REASONING);
  return {
    ...state,
    blocks: [...state.blocks, { kind: 'text', content: entry, streaming: false }],
    reasoningEntries: entries,
    reasoningTotal: (state.reasoningTotal ?? 0) + 1,
    reasoning: { content: entries.join('\n\n'), active: true },
    footer: 'thinking',
  };
}

function upsertTool(state: RunState, id: string, rawName: string): RunState {
  const known = state.knownToolIds ?? [];
  const existing = state.blocks.find(
    (block): block is Extract<Block, { kind: 'tool' }> =>
      block.kind === 'tool' && block.tool.id === id,
  );
  const visible = existing !== undefined;
  const alreadyKnown = visible || known.includes(id);
  const { name, action } = safeToolLabel(rawName);
  let blocks: Block[];
  if (visible) {
    blocks = state.blocks.map((block): Block =>
      block.kind === 'tool' && block.tool.id === id
        ? { kind: 'tool', tool: { id, name, action, status: 'running' } }
        : block,
    );
  } else if (alreadyKnown) {
    blocks = state.blocks;
  } else {
    blocks = [...state.blocks, { kind: 'tool', tool: { id, name, action, status: 'running' } }];
  }
  blocks = trimToolBlocks(blocks);
  return {
    ...state,
    blocks,
    knownToolIds: alreadyKnown ? known : [...known, id],
    footer: 'tool_running',
    reasoning: { ...state.reasoning, active: false },
  };
}

function finishTool(state: RunState, id: string, isError: boolean): RunState {
  if (!(state.knownToolIds ?? []).includes(id)) {
    return ignoreEvent(state, { type: 'tool_result', id }, 'tool-end-without-start');
  }
  let changed = false;
  const blocks = state.blocks.map((block): Block => {
    if (block.kind !== 'tool' || block.tool.id !== id) return block;
    changed = true;
    return {
      kind: 'tool',
      tool: { ...block.tool, input: undefined, output: undefined, status: isError ? 'error' : 'done' },
    };
  });
  return changed ? { ...state, blocks } : state;
}

function trimToolBlocks(blocks: Block[]): Block[] {
  let excess = blocks.reduce((count, block) => count + (block.kind === 'tool' ? 1 : 0), 0) - MAX_TOOLS;
  if (excess <= 0) return blocks;
  return blocks.filter((block) => block.kind !== 'tool' || excess-- <= 0);
}

function pushActivity(state: RunState, activity: LifecycleActivity): RunState {
  return { ...state, activityStack: [...(state.activityStack ?? []), activity] };
}

function popActivity(state: RunState, kind: LifecycleKind): RunState {
  const stack = [...(state.activityStack ?? [])];
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]?.kind !== kind) continue;
    stack.splice(index, 1);
    return { ...state, activityStack: stack };
  }
  return state;
}

function terminateNormally(state: RunState): RunState {
  const completed = completeDraft(state);
  const finalText = completed.pendingAssistant ?? completed.finalText;
  return {
    ...completed,
    blocks: finishOpenTools(completed.blocks),
    ...(finalText ? { finalText } : {}),
    pendingAssistant: undefined,
    reasoning: { ...completed.reasoning, active: false },
    footer: null,
    terminal: 'done',
    activityStack: [],
  };
}

function terminateAbnormally(state: RunState, terminal: Exclude<Terminal, 'running' | 'done'>): RunState {
  const committed = commitPendingAsReasoning(completeDraft(state));
  return {
    ...committed,
    blocks: finishOpenTools(committed.blocks),
    finalText: undefined,
    pendingAssistant: undefined,
    reasoning: { ...committed.reasoning, active: false },
    footer: null,
    terminal,
    activityStack: [],
  };
}

function finishOpenTools(blocks: Block[]): Block[] {
  return blocks.map((block): Block =>
    block.kind === 'tool' && block.tool.status === 'running'
      ? { kind: 'tool', tool: { ...block.tool, status: 'unfinished' } }
      : block,
  );
}

function ignoreEvent(state: RunState, event: unknown, reason: string): RunState {
  log.warn('card', 'event-ignored', { reason, type: eventType(event) });
  return state;
}

function eventType(event: unknown): string {
  if (
    event !== null &&
    typeof event === 'object' &&
    'type' in event &&
    typeof event.type === 'string'
  ) {
    return event.type;
  }
  return 'unknown';
}

function retryLabel(attempt?: number, maxAttempts?: number, delayMs?: number): string {
  const validAttempt = Number.isSafeInteger(attempt) && (attempt ?? 0) > 0;
  const validMax = Number.isSafeInteger(maxAttempts) && (maxAttempts ?? 0) > 0;
  const validDelay = typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0;
  if (!validAttempt || !validMax || !validDelay) return '等待重试';
  const seconds = (delayMs ?? 0) / 1000;
  const delay = Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  return `等待重试（${attempt}/${maxAttempts}，${delay}）`;
}

function safeToolLabel(rawName: string): { name: string; action: ToolAction } {
  const key = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/(read|fetch|get|view)/.test(key)) return { name: '读取信息', action: '读取' };
  if (/(grep|glob|search|find|query)/.test(key)) return { name: '搜索信息', action: '搜索' };
  if (/(edit|write|patch|replace|move|rename|delete)/.test(key)) {
    return { name: '修改内容', action: '修改' };
  }
  if (/(agent|task|delegate)/.test(key)) return { name: '协作任务', action: '协作' };
  if (/(bash|shell|exec|run|command)/.test(key)) return { name: '运行操作', action: '执行' };
  return { name: boundLabel('使用工具', MAX_TOOL_LABEL_CHARS), action: '执行' };
}

function boundLabel(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : normalized;
}
