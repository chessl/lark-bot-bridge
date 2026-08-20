import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { OmpAdapter } from '../../../src/agent/omp/adapter.js';
import type { AgentAdapter } from '../../../src/agent/types.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';

const cleanups: Array<() => Promise<void>> = [];

describe('AgentAdapter lifecycle', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('reports detailed availability through every supported adapter', async () => {
    const binary = await writeAgentBinary('agent 1.2.3');
    const adapters: AgentAdapter[] = [
      new ClaudeAdapter({ binary }),
      new CodexAdapter({ binary, profileStateDir: join(tmpdir(), 'codex-profile') }),
      new OmpAdapter({ binary }),
    ];

    for (const adapter of adapters) {
      adapter.setBotIdentity({ openId: 'ou_bot', name: 'Bridge' });
      await expect(adapter.checkAvailability()).resolves.toMatchObject({
        ok: true,
        version: 'agent 1.2.3',
      });
    }
  });

  it('validates Codex and starts the run through one asynchronous operation', async () => {
    const binary = await writeAgentBinary('codex 1.2.3');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });
    adapter.setBotIdentity({ openId: 'ou_bot' });

    const run = await adapter.start({
      runId: 'run-1',
      prompt: 'hello',
      cwd: tmpdir(),
    });

    expect(run.runId).toBe('run-1');
    await expect(run.waitForExit(1000)).resolves.toBe(true);
  });

  it('retains the detailed diagnostic when Codex startup validation fails', async () => {
    const binary = join(tmpdir(), 'missing-codex');
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: join(tmpdir(), 'codex-profile'),
    });

    await expect(
      adapter.start({ runId: 'run-1', prompt: 'hello', cwd: tmpdir() }),
    ).rejects.toMatchObject({
      code: 'agent-binary-not-found',
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'codex',
        agentName: 'Codex CLI',
        binaryPath: binary,
      },
    });
  });
});

async function writeAgentBinary(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lifecycle-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return writeVersionExecutable(dir, 'agent', version);
}
