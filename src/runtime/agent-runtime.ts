import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { OmpAdapter } from '../agent/omp/adapter';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import { accessToCodexSandbox } from '../config/permissions';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile.
 * Shared by foreground and supervised runtimes.
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'codexHomeDir'>,
): AgentAdapter {
  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      codexHomeDir: appPaths.codexHomeDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: accessToCodexSandbox(profileConfig.permissions.defaultAccess),
    });
  }
  if (profileConfig.agentKind === 'omp') {
    const omp = profileConfig.omp;
    if (!omp?.binaryPath) {
      throw new Error('omp profile requires omp.binaryPath');
    }
    return new OmpAdapter({
      binary: omp.binaryPath,
      ...(omp.profile ? { profile: omp.profile } : {}),
    });
  }
  return new ClaudeAdapter();
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
