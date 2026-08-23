import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { ScopedRuns } from '../../../src/bot/run-flow';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bot run observability', () => {
  it('keeps IM run submit logs populated with profile, source, and stage', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', workspaceRealpath);

    const result = await h.scopedRuns.start({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    await collect(result.run.events);
    await flushLogger();

    const started = (await readLogLines(h.logsDir)).find(
      (line) => line.phase === 'run' && line.event === 'started',
    );
    expect(started).toMatchObject({
      profile: 'work',
      agent: 'omp',
      source: 'im',
      stage: 'submit',
    });
    expect(JSON.stringify(started)).not.toContain('unknown');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  logsDir: string;
  agent: FakeAgentAdapter;
  scopedRuns: ScopedRuns;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-run-observability-');
  const logsDir = join(tmp.profile, 'logs');
  configureLogger({
    logsDir,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const base = createDefaultProfileConfig({
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
  });
  const profileConfig = {
    ...base,
    workspaces: {
      ...base.workspaces,
      default: tmp.workspace,
    },
  };
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await workspaces.flush();
    await tmp.cleanup();
  });
  return {
    tmp,
    logsDir,
    agent,
    scopedRuns: new ScopedRuns({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-1',
      postDoneExitGraceMs: 1,
      workspaces,
      profile: 'work',
      now: () => 1_700_000_000_000,
    }),
    workspaces,
    profileConfig,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function readLogLines(logsDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
