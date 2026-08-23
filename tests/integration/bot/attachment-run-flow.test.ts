import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { ScopedRuns } from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('attachment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('passes accepted image attachment paths to OMP image args', async () => {
    const h = await createHarness();

    const result = await h.scopedRuns.start({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: ['/media/image.png'],
    });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  scopedRuns: ScopedRuns;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('attachment-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const profileConfig = createDefaultProfileConfig({
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    omp: { binaryPath: '/usr/local/bin/omp' },
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  cleanups.push(async () => {
    await workspaces.flush();
    await tmp.cleanup();
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  return {
    tmp,
    agent,
    scopedRuns: new ScopedRuns({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-1',
      workspaces,
      profile: 'work',
      profileConfig: () => profileConfig,
      now: () => 1000,
    }),
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}
