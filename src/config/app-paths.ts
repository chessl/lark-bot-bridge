import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolveAppPathsOptions {
  rootDir?: string;
  profile?: string;
}

export interface AppPaths {
  rootDir: string;
  profile: string;
  profilesDir: string;
  trashDir: string;
  profileDir: string;
  codexHomeDir: string;
  defaultWorkspaceDir: string;
  configFile: string;
  activeProfileFile: string;
  sessionsFile: string;
  sessionCatalogFile: string;
  workspacesFile: string;
  secretsFile: string;
  keystoreSaltFile: string;
  userAuthFile: string;
  secretsGetterScript: string;
  mediaDir: string;
  callbackNoncesFile: string;
  logsDir: string;
  daemonLogsDir: string;
  daemonStdoutFile: string;
  daemonStderrFile: string;
  /** Sidecar file describing the running bridge's local web-config server
   * ({ url, token, port, pid }); written on start, removed on stop. */
  uiFile: string;
  /** Host-level (machine-wide) sidecar for the single supervisor's console. */
  hostUiFile: string;
  /** Host-level supervisor logs dir. */
  hostLogsDir: string;
  /** Machine-wide lock ensuring only one supervisor runs. */
  hostLockFile: string;
  registryDir: string;
  userRegistryFile: string;
  userLockDir: string;
  profileLockFile: string;
  appLockFile(appId: string): string;
  userAuthLockTarget(appId: string): string;
}

const DEFAULT_PROFILE = 'claude';

export function resolveAppPaths(opts: ResolveAppPathsOptions = {}): AppPaths {
  const rootDir =
    opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? join(homedir(), '.lark-bot-bridge');
  const profile = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profilesDir = join(rootDir, 'profiles');
  const profileDir = join(profilesDir, profile);
  const registryDir = join(rootDir, 'registry');
  const userLockDir = join(registryDir, 'locks');
  const sessionsFile = join(profileDir, 'sessions.json');
  const logsDir = join(profileDir, 'logs');
  const daemonLogsDir = join(logsDir, 'daemon');

  return {
    rootDir,
    profile,
    profilesDir,
    trashDir: join(rootDir, '.trash'),
    profileDir,
    codexHomeDir: join(profileDir, 'codex-home'),
    defaultWorkspaceDir: join(`${rootDir}-workspaces`, profile, 'default'),
    configFile: join(rootDir, 'config.json'),
    activeProfileFile: join(rootDir, 'active-profile'),
    sessionsFile,
    sessionCatalogFile: `${sessionsFile}.catalog.json`,
    workspacesFile: join(profileDir, 'workspaces.json'),
    secretsFile: join(profileDir, 'secrets.enc'),
    keystoreSaltFile: join(profileDir, '.keystore.salt'),
    userAuthFile: join(profileDir, 'user-auth.json'),
    secretsGetterScript: join(rootDir, 'secrets-getter'),
    callbackNoncesFile: join(profileDir, 'callback-nonces.json'),
    mediaDir: join(profileDir, 'media'),
    logsDir,
    daemonLogsDir,
    daemonStdoutFile: join(daemonLogsDir, 'daemon-stdout.log'),
    daemonStderrFile: join(daemonLogsDir, 'daemon-stderr.log'),
    uiFile: join(profileDir, 'ui.json'),
    hostUiFile: join(rootDir, 'ui.json'),
    hostLogsDir: join(rootDir, 'logs'),
    hostLockFile: join(userLockDir, 'supervisor.lock'),
    registryDir,
    userRegistryFile: join(registryDir, 'processes.json'),
    userLockDir,
    profileLockFile: join(userLockDir, 'profile', `${profile}.lock`),
    appLockFile: (appId: string) => join(userLockDir, 'app', `${lockSafeName(appId)}.lock`),
    userAuthLockTarget: (appId: string) => join(userLockDir, 'user-auth', lockSafeName(appId)),
  };
}

export const defaultAppPaths = resolveAppPaths();

function normalizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('profile name is required');
  // Allow Unicode letters/digits but reject whitespace, POSIX path separators,
  // control characters, and the special dot segments.
  const hasControlCharacter = [...trimmed].some((char) => char.charCodeAt(0) < 0x20);
  if (hasControlCharacter || /[\s/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
}

function lockSafeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
