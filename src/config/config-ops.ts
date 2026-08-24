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
import { type AppCredentials, type AppPreferences, secretKeyForApp } from './schema';

/**
 * The running bridge's `Controls` object satisfies this state. Chat commands
 * and the local UI therefore share disk writes and live in-memory refreshes.
 */
export interface MutableProfileState {
  configPath: string;
  profile: string;
  cfg: ProfileConfig;
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
  newApp: AppCredentials,
  plaintextSecret: string,
): Promise<void> {
  const appPaths = profileAppPaths(state);
  await setSecret(secretKeyForApp(newApp.id), plaintextSecret, appPaths);

  const root = await loadRootConfig(state.configPath);
  if (!root) throw new Error('config not initialized');

  const profile = root.profiles[state.profile];
  if (!profile) throw new Error(`profile not found: ${state.profile}`);
  root.profiles[state.profile] = {
    ...profile,
    app: newApp,
  };
  await saveRootConfig(root, state.configPath);
  state.cfg = runtimeProfileConfig(root, state.profile);
}

export interface SavePreferencesConfigInput {
  state: MutableProfileState;
  preferences: AppPreferences;
  requireMentionInGroup: boolean;
  mode: ProfileMode;
  /** In-meeting agent settings; omitted by callers that don't edit them. */
  meeting?: ProfileConfig['meeting'];
  /** Collaboration settings; omitted by callers that don't edit them. */
  collaboration?: ProfileConfig['collaboration'];
}

/** Persist preferences, deployment mode, and mention policy. */
export async function savePreferencesConfig(input: SavePreferencesConfigInput): Promise<void> {
  const { state, preferences, requireMentionInGroup, mode, meeting, collaboration } = input;
  await withConfigFileLock(state.configPath, async () => {
    const root = await loadRootConfig(state.configPath);
    if (!root) throw new Error('config not initialized');

    const profile = root.profiles[state.profile];
    if (!profile) throw new Error(`profile not found: ${state.profile}`);
    root.profiles[state.profile] = {
      ...profile,
      mode,
      preferences: {
        ...profile.preferences,
        ...preferences,
      },
      access: {
        ...profile.access,
        requireMentionInGroup,
      },
      ...(meeting ? { meeting } : {}),
      ...(collaboration ? { collaboration } : {}),
    };
    await saveRootConfig(root, state.configPath);
    state.cfg = runtimeProfileConfig(root, state.profile);
  });
}
