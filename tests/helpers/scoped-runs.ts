import type { AgentAdapter } from '../../src/agent/types';
import { ActiveRuns } from '../../src/bot/active-runs';
import { ProcessPool } from '../../src/bot/process-pool';
import { ScopedRuns } from '../../src/bot/run-flow';
import type { ProfileConfig } from '../../src/config/profile-schema';
import type { WorkspaceStore } from '../../src/workspace/store';

export function createTestScopedRuns(input: {
  agent: AgentAdapter;
  workspaces: WorkspaceStore;
  profileConfig: () => ProfileConfig;
  activeRuns?: ActiveRuns;
  pool?: ProcessPool;
}): ScopedRuns {
  return new ScopedRuns({
    agent: input.agent,
    activeRuns: input.activeRuns ?? new ActiveRuns(),
    pool: input.pool ?? new ProcessPool(() => 10),
    workspaces: input.workspaces,
    profile: 'test',
    profileConfig: input.profileConfig,
  });
}
