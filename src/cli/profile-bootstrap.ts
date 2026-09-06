import { mkdir, realpath } from 'node:fs/promises';
import { AgentPreflightError } from '../agent/preflight';
import { createDefaultProfileConfig, type ProfileConfig } from '../config/profile-schema';
import type { AppCredentials, AppPreferences } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './executable';

export interface BootstrapProfileInput {
  app: AppCredentials;
  preferences?: AppPreferences;
  workspace?: string;
  defaultWorkspace?: string;
  ompBinaryPath?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const profile = createDefaultProfileConfig({
    app: input.app,
    preferences: input.preferences,
    omp: await createBootstrapOmpConfig(input.ompBinaryPath),
  });
  if (workspace) profile.workspaces = { ...profile.workspaces, default: workspace };
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapOmpConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_OMP_BIN ?? 'omp';
  try {
    return { binaryPath: await resolveExecutablePath(command) };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: bootstrapBinaryErrorCode(errno),
      agentId: 'omp',
      agentName: 'Oh My Pi',
      command,
      binaryPath: command,
      errno,
    });
  }
}

function bootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
