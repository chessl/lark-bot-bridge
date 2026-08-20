import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodexAdapter process contract', () => {
  const cleanup: string[] = [];
  const oldCodexHome = process.env.CODEX_HOME;
  const oldAppSecret = process.env.APP_SECRET;

  afterEach(async () => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    if (oldAppSecret === undefined) {
      delete process.env.APP_SECRET;
    } else {
      process.env.APP_SECRET = oldAppSecret;
    }
    await Promise.all(
      cleanup
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
    );
  });

  it('spawns a fresh JSON run with prompt on stdin and inherits the user Codex home by default', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    process.env.APP_SECRET = 'inherited-secret';
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-fresh' },
        { type: 'agent_message', message: 'hello user' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      sandbox: 'read-only',
    }).start({
      runId: 'run-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-fresh' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', threadId: 'thread-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).toContain('--skip-git-repo-check');
    expect(record.argv).not.toContain('hello from lark');
    expect(record.stdin).toContain('lark_bridge');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).not.toContain('lark-cli auth login');
    expect(record.stdin).not.toContain('LARK_CHANNEL_PROFILE');
    expect(record.stdin).not.toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env).toMatchObject({
      CODEX_HOME: '/outer/codex-home',
    });
    expect(record.env.LARK_CHANNEL).toBeUndefined();
    expect(record.env.APP_SECRET).toBe('inherited-secret');
  });

  it('injects the run-scoped native MCP endpoint and bearer environment', async () => {
    const fake = await createFakeCodex({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const nativeMcp = {
      name: 'lark_bridge',
      url: 'http://127.0.0.1:12345/mcp',
      bearerToken: 'run-secret',
    };
    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
    }).start({
      runId: 'run-mcp',
      prompt: 'use lark',
      cwd,
      nativeMcp,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'danger-full-access', nativeMcp }));
    expect(record.argv.join(' ')).not.toContain(nativeMcp.bearerToken);
    expect(record.env.LARK_NATIVE_MCP_TOKEN).toBe(nativeMcp.bearerToken);
  });

  it('leaves CODEX_HOME unset by default so Codex can use the user login under ~/.codex', async () => {
    delete process.env.CODEX_HOME;
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
    }).start({
      runId: 'run-default-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBeUndefined();
  });

  it('passes image paths and resume thread through the Codex argv contract', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const image = join(fake.dir, 'image.png');

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      sandbox: 'workspace-write',
    }).start({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      images: [image],
    });

    expect(await collect(run.events)).toEqual([{ type: 'done', terminationReason: 'normal' }]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({
        cwd,
        sandbox: 'workspace-write',
        threadId: 'thread-old',
        images: [image],
      }),
    );
  });

  it('lets per-run policy sandbox override the adapter default', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      sandbox: 'danger-full-access',
    }).start({
      runId: 'run-policy-sandbox',
      prompt: 'policy sandbox',
      cwd,
      sandbox: 'read-only',
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
  });

  it('honors a profile-configured Codex home', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const codexHome = join(fake.dir, 'custom-codex-home');

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      codexHome,
    }).start({
      runId: 'run-home',
      prompt: 'home',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(codexHome);
  });

  it('uses a profile-local Codex home only when inheritance is explicitly disabled', async () => {
    process.env.CODEX_HOME = '/outer/codex-home';
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      inheritCodexHome: false,
    }).start({
      runId: 'run-profile-local-home',
      prompt: 'home',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.env.CODEX_HOME).toBe(join(fake.dir, 'codex-home'));
  });

  it('passes configured Codex ignore flags through the argv builder', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      ignoreUserConfig: false,
      ignoreRules: false,
    }).start({
      runId: 'run-flags',
      prompt: 'flags',
      cwd,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--ignore-user-config');
    expect(record.argv).not.toContain('--ignore-rules');
  });

  it('can explicitly isolate Codex from the user config', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'turn.completed' }],
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      ignoreUserConfig: true,
    }).start({
      runId: 'run-ignore-user-config',
      prompt: 'flags',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--ignore-user-config');
  });

  it('includes stderr when the process exits non-zero before a terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'agent_message', message: 'before failure' }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
    }).start({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'codex exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('continues after retryable raw error events and waits for the terminal turn event', async () => {
    const fake = await createFakeCodex({
      lines: [
        { type: 'thread.started', thread_id: 'thread-retry' },
        {
          type: 'error',
          error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
        },
        { type: 'agent_message', message: 'after retry' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
    }).start({
      runId: 'run-retry',
      prompt: 'retry',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-retry' },
      { type: 'final_text', content: 'after retry' },
      { type: 'done', threadId: 'thread-retry', terminationReason: 'normal' },
    ]);
  });

  it('reports interrupted termination when stopped before a Codex terminal event', async () => {
    const fake = await createFakeCodex({
      lines: [{ type: 'thread.started', thread_id: 'thread-stop' }],
      exitDelayMs: 5_000,
    });
    cleanup.push(fake.dir);

    const run = await new CodexAdapter({
      binary: fake.path,
      codexHomeDir: join(fake.dir, 'codex-home'),
      stopGraceMs: 20,
    }).start({
      runId: 'run-stop',
      prompt: 'stop',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', threadId: 'thread-stop' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', threadId: 'thread-stop', terminationReason: 'interrupted' },
    });
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', async () => {
    await expect(
      new CodexAdapter({ binary: 'unused', codexHomeDir: join(tmpdir(), 'codex-home') }).start({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).rejects.toThrow(/cwd is required/);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeCodex(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'if (process.argv.includes("--version")) { console.log("codex test"); process.exit(0); }',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '      LARK_NATIVE_MCP_TOKEN: process.env.LARK_NATIVE_MCP_TOKEN,',
      '      CODEX_HOME: process.env.CODEX_HOME,',
      '      APP_SECRET: process.env.APP_SECRET,',
      '      PATH: process.env.PATH,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '});',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
    LARK_NATIVE_MCP_TOKEN?: string;
    CODEX_HOME?: string;
    APP_SECRET?: string;
    PATH?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
      LARK_NATIVE_MCP_TOKEN?: string;
      CODEX_HOME?: string;
      APP_SECRET?: string;
      PATH?: string;
    };
  };
}
