import { type AppPaths, defaultAppPaths, resolveAppPaths } from '../../config/app-paths';
import { listSecretIds, removeSecret, setSecret } from '../../config/keystore';
import { loadRootConfig, readActiveProfile } from '../../config/profile-store';
import { secretKeyForApp } from '../../config/schema';
import { promptPassword } from '../prompt';

/** Human-facing commands for the encrypted per-profile keystore. */

interface SecretProfileOptions {
  profile?: string;
  rootDir?: string;
}

export async function runSecretsSet(
  appId: string | undefined,
  opts: SecretProfileOptions = {},
): Promise<void> {
  if (!appId) {
    console.error('用法: lark-bot-bridge secrets set --app-id <id>');
    process.exit(1);
  }
  const plaintext = await promptPassword(`输入 ${appId} 的 App Secret: `);
  if (!plaintext) {
    console.error('✗ 取消(secret 为空)');
    process.exit(1);
  }
  await setAppSecret(appId, plaintext, opts);
  console.log(`✓ 已加密存到 ~/.lark-bot-bridge/secrets.enc`);
}

export async function runSecretsList(opts: SecretProfileOptions = {}): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  const ids = await listSecretIds(appPaths);
  if (ids.length === 0) {
    console.log('当前没有加密存储的 secret。');
    return;
  }
  console.log(`# 当前共 ${ids.length} 个 secret 在加密存储里\n`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}

export async function runSecretsRemove(
  appId: string | undefined,
  opts: SecretProfileOptions = {},
): Promise<void> {
  if (!appId) {
    console.error('用法: lark-bot-bridge secrets remove --app-id <id>');
    process.exit(1);
  }
  const id = secretKeyForApp(appId);
  const removed = await removeAppSecret(appId, opts);
  if (!removed) {
    console.error(`✗ 没找到 secret: ${id}`);
    process.exit(1);
  }
  console.log(`✓ 已删除 ${id}`);
}

export async function setAppSecret(
  appId: string,
  plaintext: string,
  opts: SecretProfileOptions = {},
): Promise<void> {
  const appPaths = await resolveSecretProfilePaths(opts);
  await setSecret(secretKeyForApp(appId), plaintext, appPaths);
}

export async function removeAppSecret(
  appId: string,
  opts: SecretProfileOptions = {},
): Promise<boolean> {
  const appPaths = await resolveSecretProfilePaths(opts);
  return removeSecret(secretKeyForApp(appId), appPaths);
}

async function resolveSecretProfilePaths(opts: SecretProfileOptions): Promise<AppPaths> {
  const rootDir = opts.rootDir ?? defaultAppPaths.rootDir;
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  const profile =
    opts.profile ??
    (await readActiveProfile(rootDir)) ??
    root?.activeProfile ??
    defaultAppPaths.profile;
  if (root && !root.profiles[profile]) throw new Error(`profile not found: ${profile}`);
  return resolveAppPaths({ rootDir, profile });
}
