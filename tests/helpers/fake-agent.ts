import type {
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  OmpRunEngine,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
}

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: boolean;
  #stopped = false;
  #waitForExitCalls = 0;

  constructor(opts: AgentRunOptions, events: readonly AgentEvent[], waitForExitResult: boolean) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.events = this.iterate(events);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    return this.waitForExitResult;
  }

  private async *iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of events) {
      if (this.#stopped) return;
      yield event;
    }
  }
}

export type FakeAgentEvents = readonly AgentEvent[] | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements OmpRunEngine {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #eventRuns: AgentEvent[][];
  #waitForExitResults: boolean[];

  constructor(
    options: {
      events?: FakeAgentEvents;
      waitForExit?: boolean | readonly boolean[];
    } = {},
  ) {
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
  }

  async checkAvailability(): Promise<{ ok: true }> {
    return { ok: true };
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async start(opts: AgentRunOptions): Promise<AgentRun> {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const run = new FakeRun(opts, events, waitForExitResult);
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setWaitForExit(result: boolean | readonly boolean[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(result: boolean | readonly boolean[] | undefined): boolean[] {
  if (result === undefined) return [];
  if (typeof result === 'boolean') return [result];
  return [...result];
}
