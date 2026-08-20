import { dirname } from 'node:path';
import { log } from '../core/logger';
import { resolveAppPaths } from './app-paths';
import { setSecret } from './keystore';
import type { ProfileAccess, ProfileConfig, ProfileMode } from './profile-schema';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from './profile-store';
import { type AppConfig, type AppPreferences, secretKeyForApp } from './schema';

/**
 * The mutable per-profile runtime state these ops read and keep in sync. The
 * running bridge's `Controls` object structurally satisfies this, so both the
 * chat `/config` handlers and the local web UI's REST layer drive config
 * changes through the exact same disk-write + in-memory-refresh logic (no
 * divergent second implementation). `cfg` / `profileConfig` are reassigned in
 * place after a successful save so the live process picks up changes without a
 * restart — mirroring how the chat form already applies preferences/access.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: AppConfig;
  profileConfig: ProfileConfig;
}

/** App paths for a profile, derived from its config path. */
export function profileAppPaths(state: Pick<MutableProfileState, 'configPath' | 'profile'>) {
  return resolveAppPaths({
    rootDir: dirname(state.configPath),
    profile: state.profile,
  });
}

/**
 * Mutate the profile's access lists (allowlists + admins) under the config
 * file lock, persist, and refresh the in-memory state. `mutate` receives the
 * current {@link ProfileAccess} and returns the next one.
 */
export async function saveAccessConfig(
  state: MutableProfileState,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  return withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('config not initialized');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    const access = mutate(profile.access);
    root.profiles[state.profile] = {
      ...profile,
      access,
    };
    await saveRootConfig(root, state.configPath);
    state.profileConfig = root.profiles[state.profile]!;
    state.cfg = runtimeProfileConfig(root, state.profile);
    log.info('config-ops', 'access-mutated', {
      allowedUsers: access.allowedUsers.length,
      allowedChats: access.allowedChats.length,
      admins: access.admins.length,
    });
    return access;
  });
}

/**
 * Store a new App Secret in the keystore and persist the account config
 * (SecretRef in config.json, plaintext only in the keystore), refreshing
 * in-memory state. Callers restart the bridge afterwards to reconnect with
 * the new credentials.
 */
export async function saveAccountConfig(
  state: MutableProfileState,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = profileAppPaths(state);
  await setSecret(secretKeyForApp(newCfg.accounts.app.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(state.configPath);
  if (!root) throw new Error('config not initialized');

  const profile = root.profiles[state.profile];
  if (!profile) throw new Error(`profile not found: ${state.profile}`);
  root.profiles[state.profile] = {
    ...profile,
    accounts: newCfg.accounts,
  };
  if (newCfg.secrets) root.secrets = newCfg.secrets;
  await saveRootConfig(root, state.configPath);
  state.profileConfig = root.profiles[state.profile]!;
  state.cfg = runtimeProfileConfig(root, state.profile);
}

/** Persist preferences, deployment mode, and mention policy. */
export async function savePreferencesConfig(
  state: MutableProfileState,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  mode: ProfileMode,
  /** In-meeting agent settings; omitted by callers that don't edit them. */
  meeting?: ProfileConfig['meeting'],
): Promise<void> {
  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('config not initialized');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    const {
      requireMentionInGroup: _requireMention,
      access: _access,
      ...profilePreferences
    } = preferences;
    root.profiles[state.profile] = {
      ...profile,
      mode,
      preferences: {
        ...profile.preferences,
        ...profilePreferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      ...(meeting ? { meeting } : {}),
    };
    await saveRootConfig(root, state.configPath);
    state.profileConfig = root.profiles[state.profile]!;
    state.cfg = runtimeProfileConfig(root, state.profile);
  });
}
