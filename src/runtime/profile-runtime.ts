import { dirname } from 'node:path';
import * as p from '@clack/prompts';
import { runRegistrationWizard } from '../bot/wizard';
import { type DetectedAgent, detectInstalledAgents } from '../cli/agent-detection';
import { createBootstrapProfileConfig } from '../cli/profile-bootstrap';
import { promptPassword } from '../cli/prompt';
import { type AppPaths, resolveAppPaths } from '../config/app-paths';
import { setSecret } from '../config/keystore';
import {
  type AgentKind,
  type CreateDefaultProfileConfigInput,
  createDefaultProfileConfig,
  type ProfileConfig,
  type RootConfig,
} from '../config/profile-schema';
import {
  agentKindFromString,
  createRootConfig,
  loadRootConfig,
  readActiveProfile,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../config/profile-store';
import type { AppConfig, SecretInput, TenantBrand } from '../config/schema';
import { isSecretRef, secretKeyForApp } from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { buildEncryptedAccountConfig } from '../config/store';
import { validateAppCredentials } from '../utils/feishu-auth';

export interface ResolveProfileRuntimeOptions {
  config?: string;
  profile?: string;
  agent?: string;
  workspace?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  allowBootstrap?: boolean;
  selectAgent?: (
    detected: DetectedAgent[],
  ) => AgentKind | undefined | Promise<AgentKind | undefined>;
}

export interface ProfileRuntime {
  cfg: AppConfig & { agentKind?: AgentKind };
  profileConfig: ProfileConfig;
  configPath: string;
  appPaths: AppPaths;
  profile: string;
}

export interface MaterializeEnvSecretForServiceOptions {
  config?: string;
  profile?: string;
}

const ENV_SECRET_TEMPLATE_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

export function createRuntimeProfileConfig(input: CreateDefaultProfileConfigInput): ProfileConfig {
  return createDefaultProfileConfig({
    ...input,
    ...(input.agentKind === 'codex'
      ? { codex: input.codex ?? { binaryPath: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex' } }
      : {}),
    ...(input.agentKind === 'omp'
      ? { omp: input.omp ?? { binaryPath: process.env.LARK_CHANNEL_OMP_BIN ?? 'omp' } }
      : {}),
  });
}

export async function resolveProfileRuntime(
  opts: ResolveProfileRuntimeOptions,
): Promise<ProfileRuntime> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const requestedAgent = agentKindFromString(opts.agent);
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? requestedAgent;
  if (!profile && opts.allowBootstrap) {
    const detected = await detectInstalledAgents();
    if (detected.length === 0) {
      throw new Error('no supported local agent found; install claude, codex, or omp first');
    }
    if (detected.length > 1) {
      const selected = await selectDetectedAgent(detected, opts.selectAgent);
      if (!selected) {
        throw new Error(formatAmbiguousAgentSelectionError(detected));
      }
      profile = selected;
    } else {
      profile = detected[0]?.kind;
    }
  }
  if (!profile && !opts.allowBootstrap) {
    throw new Error('active profile is required');
  }
  profile ??= 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) {
      if (opts.allowBootstrap && explicitProfile) {
        return bootstrapProfileIntoExistingRoot({
          rootConfig,
          profile,
          requestedAgent,
          opts,
          appPaths,
          configPath,
        });
      }
      throw new Error(`profile not found: ${profile}`);
    }
    assertRequestedAgentMatchesExistingProfile(profile, profileConfig, requestedAgent);
    assertBootstrapAppMatchesExistingProfile(opts, profile, profileConfig);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    return { cfg, profileConfig, configPath, appPaths, profile };
  }

  if (!opts.allowBootstrap) {
    throw new Error('config not initialized');
  }
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const root = createRootConfig(profile, profileConfig, encrypted.secrets);
  await saveRootConfig(root, configPath);
  await writeActiveProfile(appPaths.rootDir, profile);
  console.log(`配置已保存到 ${configPath}\n`);
  return { cfg: runtimeProfileConfig(root, profile), profileConfig, configPath, appPaths, profile };
}

async function bootstrapProfileIntoExistingRoot(args: {
  rootConfig: RootConfig;
  profile: string;
  requestedAgent: AgentKind | undefined;
  opts: ResolveProfileRuntimeOptions;
  appPaths: AppPaths;
  configPath: string;
}): Promise<ProfileRuntime> {
  const { rootConfig, profile, requestedAgent, opts, appPaths, configPath } = args;
  const bootstrapAgent = resolveBootstrapAgent(requestedAgent, profile) ?? 'claude';
  const workspace = opts.workspace;
  const fresh = await resolveBootstrapAppConfig(opts);
  const encrypted = await encryptedConfigForProfile(fresh, appPaths);
  const profileConfig = await createBootstrapProfileConfig({
    agentKind: bootstrapAgent,
    accounts: encrypted.accounts,
    preferences: encrypted.preferences,
    secrets: encrypted.secrets,
    workspace,
    defaultWorkspace: appPaths.defaultWorkspaceDir,
    profileDir: appPaths.profileDir,
  });
  const nextRoot: RootConfig = {
    ...rootConfig,
    ...((rootConfig.secrets ?? encrypted.secrets)
      ? { secrets: rootConfig.secrets ?? encrypted.secrets }
      : {}),
    profiles: {
      ...rootConfig.profiles,
      [profile]: {
        ...profileConfig,
        secrets: undefined,
      },
    },
  };
  await saveRootConfig(nextRoot, configPath);
  console.log(`配置已保存到 ${configPath}\n`);
  return {
    cfg: runtimeProfileConfig(nextRoot, profile),
    profileConfig,
    configPath,
    appPaths,
    profile,
  };
}

function resolveBootstrapAgent(
  requestedAgent: AgentKind | undefined,
  profile: string | undefined,
): AgentKind | undefined {
  if (requestedAgent) return requestedAgent;
  if (profile === 'codex' || profile === 'omp') return profile;
  return undefined;
}

async function resolveBootstrapAppConfig(opts: ResolveProfileRuntimeOptions): Promise<AppConfig> {
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
  if (result.botName) {
    console.log(`✓ 应用凭证校验通过: ${result.botName}`);
  } else {
    console.log('✓ 应用凭证校验通过');
  }
  return {
    accounts: {
      app: {
        id: opts.appId,
        secret: appSecret,
        tenant,
      },
    },
  };
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
  profileConfig: ProfileConfig,
): void {
  if (!opts.appId || opts.appId === profileConfig.accounts.app.id) return;
  throw new Error(
    `profile already exists: ${profile}; it uses app ${profileConfig.accounts.app.id}. ` +
      'omit --app-id or create another profile',
  );
}

function assertRequestedAgentMatchesExistingProfile(
  profile: string,
  profileConfig: ProfileConfig,
  requestedAgent: AgentKind | undefined,
): void {
  if (!requestedAgent || profileConfig.agentKind === requestedAgent) return;
  throw new Error(
    `profile ${profile} already exists with agentKind ${profileConfig.agentKind}, ` +
      `but this command requested --agent ${requestedAgent}. ` +
      `Profile names are labels; to use the existing ${profileConfig.agentKind} profile, omit --agent. ` +
      `To recreate it as ${requestedAgent}, remove profile ${profile} first.`,
  );
}

export async function materializeEnvSecretForService(
  opts: MaterializeEnvSecretForServiceOptions = {},
): Promise<boolean> {
  const rootDir = opts.config ? dirname(opts.config) : undefined;
  const explicitProfile = opts.profile;
  const activeProfile = explicitProfile ?? (await readActiveProfile(rootDir));
  let profile = activeProfile ?? 'claude';
  let appPaths = resolveAppPaths({ rootDir, profile });
  const configPath = opts.config ?? appPaths.configFile;

  const rootConfig = await loadRootConfig(configPath);
  if (rootConfig) {
    if (!explicitProfile && !activeProfile) {
      profile = rootConfig.activeProfile;
      appPaths = resolveAppPaths({ rootDir, profile });
    }
    const profileConfig = rootConfig.profiles[profile];
    if (!profileConfig) throw new Error(`profile not found: ${profile}`);
    const cfg = runtimeProfileConfig(rootConfig, profile);
    if (!isEnvBackedSecret(cfg.accounts.app.secret)) return false;

    const encrypted = await encryptedConfigForResolvedSecret(
      cfg,
      await resolveAppSecret(cfg, appPaths),
      appPaths,
    );
    rootConfig.profiles[profile] = {
      ...profileConfig,
      accounts: encrypted.accounts,
    };
    if (encrypted.secrets) rootConfig.secrets = encrypted.secrets;
    await saveRootConfig(rootConfig, configPath);
    return true;
  }

  return false;
}

function formatAmbiguousAgentSelectionError(
  detected: Array<{ kind: AgentKind; binaryPath: string }>,
): string {
  const lines = detected.map((agent) => `  - ${agent.kind}: ${agent.binaryPath}`);
  return [
    '检测到多个本地 agent，请使用 --agent <claude|codex|omp> 指定要初始化哪一个。',
    '已检测到：',
    ...lines,
  ].join('\n');
}

async function selectDetectedAgent(
  detected: DetectedAgent[],
  selector: ResolveProfileRuntimeOptions['selectAgent'],
): Promise<AgentKind | undefined> {
  const selected = selector
    ? await selector(detected)
    : await promptForDetectedAgentSelection(detected);
  if (!selected) return undefined;
  return detected.some((agent) => agent.kind === selected) ? selected : undefined;
}

async function promptForDetectedAgentSelection(
  detected: DetectedAgent[],
): Promise<AgentKind | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  p.intro('选择本地 agent');
  const selected = await p.select<AgentKind>({
    message: '检测到多个本地 agent，本次要初始化哪一个？',
    options: detected.map((agent) => ({
      value: agent.kind,
      label: displayAgentKind(agent.kind),
      hint: agent.binaryPath,
    })),
    initialValue: detected[0]?.kind,
  });
  if (p.isCancel(selected)) {
    p.cancel('已取消 agent 选择。');
    throw new UserCancelledError('已取消启动。');
  }
  p.outro(`已选择 ${displayAgentKind(selected)}`);
  return selected;
}

class UserCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserCancelledError';
  }
}

function displayAgentKind(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'omp':
      return 'Oh My Pi';
  }
}

async function encryptedConfigForProfile(
  cfg: AppConfig,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const secret = cfg.accounts.app.secret;
  if (typeof secret !== 'string') return cfg;
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), secret, appPaths);
  return next;
}

async function encryptedConfigForResolvedSecret(
  cfg: AppConfig,
  plaintext: string,
  appPaths: Pick<AppPaths, 'secretsGetterScript' | 'secretsFile' | 'keystoreSaltFile'>,
): Promise<AppConfig> {
  const next = await buildEncryptedAccountConfig(
    cfg.accounts.app.id,
    cfg.accounts.app.tenant,
    cfg.preferences,
    appPaths,
  );
  await setSecret(secretKeyForApp(cfg.accounts.app.id), plaintext, appPaths);
  return next;
}

function isEnvBackedSecret(secret: SecretInput): boolean {
  if (typeof secret === 'string') return ENV_SECRET_TEMPLATE_RE.test(secret);
  return isSecretRef(secret) && secret.source === 'env';
}
