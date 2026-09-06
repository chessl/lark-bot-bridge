import { dirname } from 'node:path';
import { runRegistrationWizard } from '../bot/wizard';
import { createBootstrapProfileConfig } from '../cli/profile-bootstrap';
import { promptPassword } from '../cli/prompt';
import { type AppPaths, defaultAppPaths, resolveAppPaths } from '../config/app-paths';
import { setSecret } from '../config/keystore';
import type { ProfileConfig, RootConfig } from '../config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  readActiveProfile,
  saveRootConfig,
} from '../config/profile-store';
import {
  type AppCredentials,
  type AppPreferences,
  keystoreAppCredentials,
  secretKeyForApp,
  type TenantBrand,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface ResolveProfileRuntimeOptions {
  config?: string;
  profile?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  allowBootstrap?: boolean;
}

export interface ProfileRuntime {
  cfg: ProfileConfig;
  configPath: string;
  appPaths: AppPaths;
  profile: string;
}

export interface MaterializeEnvSecretForServiceOptions {
  config?: string;
  profile?: string;
}

interface BootstrapAppConfig {
  app: AppCredentials;
  preferences?: AppPreferences;
}

const ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

export async function resolveProfileRuntime(
  opts: ResolveProfileRuntimeOptions,
): Promise<ProfileRuntime> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? defaultAppPaths.profile;
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const cfg = rootConfig.profiles[profile];
    if (!cfg) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile,
          opts,
          appPaths,
          configPath,
        });
      }
      throw new Error(`profile not found: ${profile}`);
    }
    assertBootstrapAppMatchesExistingProfile(opts, profile, cfg);
    return { cfg, configPath, appPaths, profile };
  }

  if (!opts.allowBootstrap) throw new Error('config not initialized');
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptBootstrapAppConfig(fresh, appPaths);
  const cfg = await createBootstrapProfileConfig({
    app: encrypted.app,
    preferences: encrypted.preferences,
    workspace: opts.workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
  });
  await saveRootConfig(createRootConfig(profile, cfg), configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return { cfg, configPath, appPaths, profile };
}

async function bootstrapProfileIntoExistingRoot(args: {
  rootConfig: RootConfig;
  profile: string;
  opts: ResolveProfileRuntimeOptions;
  appPaths: AppPaths;
  configPath: string;
}): Promise<ProfileRuntime> {
  const { rootConfig, profile, opts, appPaths, configPath } = args;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptBootstrapAppConfig(fresh, appPaths);
  const cfg = await createBootstrapProfileConfig({
    app: encrypted.app,
    preferences: encrypted.preferences,
    workspace: opts.workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
  });
  rootConfig.profiles[profile] = cfg;
  await saveRootConfig(rootConfig, configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return { cfg, configPath, appPaths, profile };
}

async function resolveBootstrapAppConfig(
  opts: ResolveProfileRuntimeOptions,
): Promise<BootstrapAppConfig> {
  if (!opts.appId) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        '当前没有配置，非交互模式无法完成扫码创建应用。' +
          '请先在终端运行 `lark-bot-bridge run` 完成首次初始化，' +
          '或传入 --app-id 和 --app-secret。',
      );
    }
    return runRegistrationWizard();
  }
  let appSecret = opts.appSecret;
  if (!appSecret) {
    if (!isInteractiveTerminal()) {
      throw new Error(
        `非交互模式缺少 App Secret: ${opts.appId}。` +
          '请传入 --app-secret <secret>，或在终端中重新运行命令后按提示输入。',
      );
    }
    appSecret = await promptPassword(`输入 ${opts.appId} 的 App Secret: `);
  }
  if (!appSecret) throw new Error('app secret is required');
  const tenant = tenantBrandFromString(opts.tenant);
  const result = await validateAppCredentials(opts.appId, appSecret, tenant);
  if (!result.ok) {
    throw new Error(`app credentials validation failed: ${result.reason ?? 'unknown'}`);
  }
  console.log(result.botName ? `✓ 应用凭证校验通过: ${result.botName}` : '✓ 应用凭证校验通过');
  return { app: { id: opts.appId, secret: appSecret, tenant } };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function tenantBrandFromString(value: string | undefined): TenantBrand {
  if (value === undefined) return 'feishu';
  if (value === 'feishu' || value === 'lark') return value;
  throw new Error(`unsupported tenant: ${value}`);
}

function assertBootstrapAppMatchesExistingProfile(
  opts: ResolveProfileRuntimeOptions,
  profile: string,
  cfg: ProfileConfig,
): void {
  if (!opts.appId || opts.appId === cfg.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${cfg.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

export async function materializeEnvSecretForService(
  opts: MaterializeEnvSecretForServiceOptions = {},
): Promise<boolean> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? defaultAppPaths.profile;
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (!rootConfig) return false;
  if (!explicitProfile && !activeProfile) {
    profile = rootConfig.activeProfile;
    appPaths = resolveAppPaths({ rootDir, profile });
  }
  const cfg = rootConfig.profiles[profile];
  if (!cfg) throw new Error(`profile not found: ${profile}`);
  if (typeof cfg.app.secret !== 'string' || !ENV_SECRET_TEMPLATE_RE.test(cfg.app.secret)) {
    return false;
  }

  rootConfig.profiles[profile] = {
    ...cfg,
    app: await storeAppSecret(cfg.app, await resolveAppSecret(cfg, appPaths), appPaths),
  };
  await saveRootConfig(rootConfig, configPath);
  return true;
}

async function encryptBootstrapAppConfig(
  cfg: BootstrapAppConfig,
  appPaths: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>,
): Promise<BootstrapAppConfig> {
  if (typeof cfg.app.secret !== 'string') return cfg;
  return { ...cfg, app: await storeAppSecret(cfg.app, cfg.app.secret, appPaths) };
}

async function storeAppSecret(
  app: AppCredentials,
  plaintext: string,
  appPaths: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppCredentials> {
  await setSecret(secretKeyForApp(app.id), plaintext, appPaths);
  return keystoreAppCredentials(app.id, app.tenant);
}
