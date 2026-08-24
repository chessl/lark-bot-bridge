import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOmpArgs, OmpAdapter } from '../../src/agent/omp/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeOmp {
  path: string;
  dir: string;
  recordPath: string;
}

describe('OmpAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
    );
  });

  it('negotiates RPC v2, streams events, and persists the OMP session id', async () => {
    const fake = await createFakeOmp();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new OmpAdapter({ binary: fake.path });
    adapter.setBotIdentity({ openId: 'ou_bot', name: 'OMP Bot' });

    const run = await adapter.start({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'prompt_sent' },
      {
        type: 'system',
        sessionId: 'omp-session-1',
        modelId: 'gpt-test',
        effort: 'high',
        contextPercent: 7.25,
      },
      { type: 'text_started' },
      { type: 'final_text', content: 'hello user' },
      { type: 'reasoning', content: 'approved reasoning' },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputDurationMs: 3_000,
      },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } },
      { type: 'tool_result', id: 'tool-1', output: 'done', isError: false },
      { type: 'done', sessionId: 'omp-session-1', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(2000)).toBe(true);

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
      systemPrompt: string;
      commands: Array<Record<string, unknown>>;
    };
    expect(record.argv).toEqual(buildOmpArgs({ systemPromptFile: record.argv[6]! }));
    expect(record.env).toEqual({});
    expect(record.systemPrompt).toContain('lark-bot-bridge 运行约定');
    expect(record.systemPrompt).toContain('ou_bot');
    expect(record.commands.map((command) => command.type)).toEqual([
      'negotiate_protocol',
      'get_state',
      'prompt',
    ]);
    expect(record.commands[2]).toMatchObject({ message: 'hello from lark' });
    expect(record.argv).not.toContain('hello from lark');
  });

  it('passes profile, model, resume id, and image payload through RPC', async () => {
    const fake = await createFakeOmp();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');
    await writeFile(image, Buffer.from([0, 1, 2, 3]));

    const run = await new OmpAdapter({ binary: fake.path, profile: 'work' }).start({
      runId: 'run-resume',
      prompt: 'inspect image',
      cwd,
      sessionId: 'session-old',
      model: 'openai/gpt-test',
      images: [image],
    });
    await collect(run.events);
    expect(await run.waitForExit(2000)).toBe(true);

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      argv: string[];
      commands: Array<Record<string, unknown>>;
    };
    expect(record.argv).toEqual(
      buildOmpArgs({
        systemPromptFile: record.argv[6]!,
        profile: 'work',
        sessionId: 'session-old',
        model: 'openai/gpt-test',
      }),
    );
    expect(record.commands[2]).toMatchObject({
      type: 'prompt',
      images: [{ type: 'image', data: 'AAECAw==', mimeType: 'image/png' }],
    });
  });

  it('injects and then removes a run-scoped native MCP config', async () => {
    const fake = await createFakeOmp();
    cleanup.push(fake.dir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(fake.dir, 'agent');
    const nativeMcp = {
      name: 'lark_bridge',
      url: 'http://127.0.0.1:12345/mcp',
      bearerToken: 'run-secret',
    };
    try {
      const run = await new OmpAdapter({ binary: fake.path }).start({
        runId: 'run-mcp',
        prompt: 'use lark',
        cwd: await realpath(fake.dir),
        nativeMcp,
      });
      await collect(run.events);
      expect(await run.waitForExit(2000)).toBe(true);
      const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
        env: Record<string, string>;
        mcpConfig: unknown;
      };
      expect(record.env.LARK_NATIVE_MCP_TOKEN).toBe(nativeMcp.bearerToken);
      expect(record.mcpConfig).toEqual({
        mcpServers: {
          lark_bridge: {
            type: 'http',
            url: nativeMcp.url,
            headers: { Authorization: 'Bearer ${LARK_NATIVE_MCP_TOKEN}' },
          },
        },
      });
      await expect(readFile(join(fake.dir, 'agent', 'mcp.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

async function createFakeOmp(): Promise<FakeOmp> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-omp-'));
  const path = join(dir, 'omp.mjs');
  const recordPath = join(dir, 'record.json');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const recordPath = ${JSON.stringify(recordPath)};
const appendIndex = process.argv.indexOf('--append-system-prompt');
const mcpPath = process.env.PI_CODING_AGENT_DIR ? process.env.PI_CODING_AGENT_DIR + '/mcp.json' : '';
const record = {
  argv: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LARK_') || key === 'LARKSUITE_CLI_CONFIG_DIR')),
  systemPrompt: appendIndex >= 0 ? readFileSync(process.argv[appendIndex + 1], 'utf8') : '',
  mcpConfig: mcpPath && existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null,
  commands: [],
};
const save = () => writeFileSync(recordPath, JSON.stringify(record));
process.on('exit', save);
console.log(JSON.stringify({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: 67108864 }));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const command = JSON.parse(line);
  record.commands.push(command);
  if (command.type === 'negotiate_protocol') {
    console.log(JSON.stringify({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } }));
  } else if (command.type === 'get_state') {
    console.log(JSON.stringify({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-1', model: { provider: 'openai', id: 'gpt-test' }, thinkingLevel: 'high', contextUsage: { tokens: 725, contextWindow: 10000, percent: 7.25 } } }));
  } else if (command.type === 'prompt') {
    console.log(JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } }));
    console.log(JSON.stringify({ type: 'agent_start' }));
    console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' } }));
    console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } }));
    console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'user' } }));
    console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'approved reasoning' }, { type: 'text', text: 'hello user' }], usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } }, duration: 5000, ttft: 2000 } }));
    console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } }));
    console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tool-1', result: { content: [{ type: 'text', text: 'done' }] } }));
    console.log(JSON.stringify({ type: 'agent_end', isTerminal: false }));
    console.log(JSON.stringify({ type: 'agent_end', isTerminal: true }));
  }
});
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
