import { resolveAppPaths } from '../config/app-paths';
import { loadRootConfig, saveRootConfig, withConfigFileLock } from '../config/profile-store';
import { listAllProfiles } from '../runtime/profile-discovery';
import { HttpError } from './http';
import type { UiSupervisor } from './types';

export interface ProfileSummary {
  name: string;
  active: boolean;
  /** Whether the supervisor currently hosts this profile's channel. */
  running: boolean;
}

export interface BotSummary {
  id: string;
  profileName: string;
  botName?: string;
  appId?: string;
  pid: number;
  version: string;
  startedAt?: string;
  uptimeMs: number;
}

/** Online channels the supervisor currently hosts (all under one pid). */
export function listBots(supervisor: UiSupervisor, version: string, now: number): BotSummary[] {
  return supervisor.list().map((s) => ({
    id: s.profile,
    profileName: s.profile,
    botName: s.botName,
    appId: s.appId,
    pid: s.pid,
    version,
    startedAt: s.startedAt,
    uptimeMs: s.startedAt ? Math.max(0, now - Date.parse(s.startedAt)) : 0,
  }));
}

/** All profiles with active and supervisor status. */
export async function listProfiles(
  supervisor: UiSupervisor,
  rootDir?: string,
): Promise<ProfileSummary[]> {
  const profiles = await listAllProfiles(rootDir).catch(() => []);
  return profiles.map((p) => ({
    name: p.name,
    active: p.active,
    running: supervisor.isOnline(p.name),
  }));
}

/** Switch the active profile (disk metadata only; does not stop/start channels). */
export async function activateProfile(
  name: string,
  rootDir?: string,
): Promise<{ ok: true; active: string }> {
  const appPaths = resolveAppPaths({ rootDir });
  await withConfigFileLock(appPaths.configFile, async () => {
    const root = await loadRootConfig(appPaths.configFile);
    if (!root?.profiles[name]) throw new HttpError(404, `profile not found: ${name}`);
    root.activeProfile = name;
    await saveRootConfig(root, appPaths.configFile);
  });
  return { ok: true, active: name };
}
