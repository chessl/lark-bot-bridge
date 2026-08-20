import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultAppPaths, resolveAppPaths } from '../config/app-paths';

/** Logical service name used by launchd and systemd. */
export const SERVICE_NAME = 'lark-bot-bridge.bot';

/**
 * Reserved service id for the machine-wide supervisor+console daemon
 * (`start --web-ui`). Keyed distinctly from any real profile so the supervisor
 * service has a fixed label/log path (one per machine) and never flaps against
 * per-profile classic services. It passes `serviceProfileId` validation, so it
 * flows through the same label/unit/task/log helpers as a profile.
 */
export const SUPERVISOR_SERVICE_ID = 'supervisor';

export function serviceProfileId(profile: string): string {
  const validated = resolveAppPaths({ rootDir: defaultAppPaths.rootDir, profile }).profile;
  // ASCII-safe names pass through unchanged. Other names get a deterministic
  // ASCII-safe id.
  if (/^[A-Za-z0-9._-]+$/.test(validated)) return validated;
  const base =
    validated
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 24) || 'profile';
  const hash = createHash('sha1').update(validated).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function serviceNameForProfile(profile: string = defaultAppPaths.profile): string {
  return `${SERVICE_NAME}.${serviceProfileId(profile)}`;
}

// === macOS launchd ===

export const LAUNCH_AGENT_LABEL = launchAgentLabel();

export function launchAgentLabel(profile: string = defaultAppPaths.profile): string {
  return `ai.${serviceNameForProfile(profile)}`;
}

/**
 * macOS convention: user LaunchAgents under `~/Library/LaunchAgents/`.
 * launchd discovers plists only from a few well-known paths.
 */
export function launchAgentPlistPath(profile: string = defaultAppPaths.profile): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel(profile)}.plist`);
}

// === Linux systemd (user units) ===

export const SYSTEMD_UNIT_NAME = systemdUnitName();

export function systemdUnitName(profile: string = defaultAppPaths.profile): string {
  return `${serviceNameForProfile(profile)}.service`;
}

/**
 * Linux convention: user systemd units under
 * `$XDG_CONFIG_HOME/systemd/user/`, defaulting to
 * `~/.config/systemd/user/` when XDG_CONFIG_HOME isn't set.
 */
export function systemdUnitPath(profile: string = defaultAppPaths.profile): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', systemdUnitName(profile));
}

// === Daemon log paths (platform-agnostic) ===

/**
 * Daemon stdout/stderr go alongside the bridge's own structured logs in
 * `~/.lark-bot-bridge/logs/` so users only need to remember one path. Filenames
 * are `daemon-*` to keep them distinct from the rolling per-day JSON files.
 */
export function daemonLogDir(profile: string = defaultAppPaths.profile): string {
  return resolveAppPaths({ rootDir: defaultAppPaths.rootDir, profile }).daemonLogsDir;
}

export function daemonStdoutPath(profile: string = defaultAppPaths.profile): string {
  return resolveAppPaths({ rootDir: defaultAppPaths.rootDir, profile }).daemonStdoutFile;
}

export function daemonStderrPath(profile: string = defaultAppPaths.profile): string {
  return resolveAppPaths({ rootDir: defaultAppPaths.rootDir, profile }).daemonStderrFile;
}
