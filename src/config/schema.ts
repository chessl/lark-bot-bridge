export type TenantBrand = 'feishu' | 'lark';

/** A secret stored in the bridge's encrypted local keystore. */
export interface SecretRef {
  source: 'keystore';
  id: string;
}

/** Plain text, a `${VAR}` template, or an encrypted keystore reference. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

export interface AppPreferences {
  /** OMP model forwarded as `--model`; undefined or `default` uses the OMP profile default. */
  model?: string;
  /** Concurrent OMP run cap. Default 10, maximum 50. */
  maxConcurrentRuns?: number;
  /** Global OMP idle timeout in minutes. Undefined or 0 disables it. */
  runIdleTimeoutMinutes?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5000ms. */
  agentStopGraceMs?: number;
}

export function isComplete(cfg: { app?: Partial<AppCredentials> }): cfg is { app: AppCredentials } {
  const app = cfg.app;
  return Boolean(app?.id && hasSecret(app.secret) && app.tenant);
}

function hasSecret(secret: SecretInput | undefined): boolean {
  if (!secret) return false;
  return typeof secret === 'string' ? secret.length > 0 : Boolean(secret.id);
}

export function isSecretRef(secret: SecretInput): secret is SecretRef {
  return typeof secret === 'object' && secret !== null;
}

export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

export function keystoreAppCredentials(id: string, tenant: TenantBrand): AppCredentials {
  return {
    id,
    tenant,
    secret: { source: 'keystore', id: secretKeyForApp(id) },
  };
}

export function getMaxConcurrentRuns(cfg: { preferences?: AppPreferences }): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}

export function getRequireMentionInGroup(cfg: {
  access: { requireMentionInGroup: boolean };
}): boolean {
  return cfg.access.requireMentionInGroup;
}

export function getAgentStopGraceMs(cfg: { preferences?: AppPreferences }): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

export function getRunIdleTimeoutMs(cfg: { preferences?: AppPreferences }): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.max(Math.floor(raw), 1), 120) * 60_000;
}
