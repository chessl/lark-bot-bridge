import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveAppPaths } from './app-paths';
import { normalizeProfileConfig, type ProfileConfig, type RootConfig } from './profile-schema';

interface RawRootConfig {
  schemaVersion: 3;
  activeProfile: string;
  profiles: Record<string, unknown>;
}

export async function loadRootConfig(path: string): Promise<RootConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'schemaVersion' in parsed &&
      parsed.schemaVersion !== 3
    ) {
      throw new Error('incompatible Root Config format: expected schemaVersion 3');
    }
    return isRootConfig(parsed) ? normalizeRootConfig(parsed) : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function normalizeRootConfig(root: RawRootConfig): RootConfig {
  const profiles: RootConfig['profiles'] = {};
  for (const [name, profile] of Object.entries(root.profiles)) {
    profiles[name] = normalizeProfileConfig(profile);
  }
  return {
    schemaVersion: 3,
    activeProfile: root.activeProfile,
    profiles,
  };
}

export async function saveRootConfig(root: RootConfig, path: string): Promise<void> {
  await writeFileAtomic(path, formatRootConfig(root), { mode: 0o600 });
}

export function formatRootConfig(root: RootConfig): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

export async function withConfigFileLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${configPath}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function readActiveProfile(rootDir?: string): Promise<string | undefined> {
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  return root?.activeProfile || undefined;
}

export function runtimeProfileConfig(root: RootConfig, profile: string): ProfileConfig {
  const cfg = root.profiles[profile];
  if (!cfg) throw new Error(`profile not found: ${profile}`);
  return cfg;
}

export function createRootConfig(profile: string, cfg: ProfileConfig): RootConfig {
  return {
    schemaVersion: 3,
    activeProfile: profile,
    profiles: { [profile]: cfg },
  };
}

export function isRootConfig(value: unknown): value is RawRootConfig {
  if (!value || typeof value !== 'object') return false;
  const root = value as Partial<RawRootConfig>;
  return root.schemaVersion === 3 && Boolean(root.profiles && typeof root.profiles === 'object');
}

export interface RemoveProfileOptions {
  purge?: boolean;
  now?: () => Date;
}

export interface RemoveProfileResult {
  root: RootConfig;
  archivedTo?: string;
  purged?: boolean;
  restore?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

export async function removeProfile(
  root: RootConfig,
  profile: string,
  rootDir: string,
  opts: RemoveProfileOptions = {},
): Promise<RemoveProfileResult> {
  if (!root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  const next: RootConfig = {
    ...root,
    profiles: { ...root.profiles },
  };
  delete next.profiles[profile];
  if (root.activeProfile === profile) {
    next.activeProfile = Object.keys(next.profiles).sort((a, b) => a.localeCompare(b))[0] ?? '';
  }
  const { profileDir, trashDir } = resolveAppPaths({ rootDir, profile });
  if (opts.purge) {
    if (!(await pathExists(profileDir))) return { root: next, purged: true };
    await mkdir(trashDir, { recursive: true });
    const stagedTo = await nextArchivePath(trashDir, profile, opts.now?.() ?? new Date());
    await rename(profileDir, stagedTo);
    return {
      root: next,
      archivedTo: stagedTo,
      purged: true,
      restore: async () => {
        await rename(stagedTo, profileDir);
      },
      cleanup: async () => {
        await rm(stagedTo, { recursive: true, force: true });
        await rmdir(trashDir).catch(() => {});
      },
    };
  }

  await mkdir(trashDir, { recursive: true });
  const archivedTo = await nextArchivePath(trashDir, profile, opts.now?.() ?? new Date());
  await rename(profileDir, archivedTo);
  return {
    root: next,
    archivedTo,
    restore: async () => {
      await rename(archivedTo, profileDir);
    },
  };
}

async function nextArchivePath(trashDir: string, profile: string, now: Date): Promise<string> {
  const base = join(trashDir, `${profile}-${archiveTimestamp(now)}`);
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
}

function archiveTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
