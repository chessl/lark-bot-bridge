import { defaultAppPaths } from './app-paths';
import { getSecret, type KeystorePaths } from './keystore';
import type { ProfileConfig } from './profile-schema';

const ENV_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;

/** Resolve the app secret from plaintext, an environment template, or the local keystore. */
export async function resolveAppSecret(
  cfg: Pick<ProfileConfig, 'app'>,
  secretPaths: KeystorePaths = defaultAppPaths,
): Promise<string> {
  const secret = cfg.app.secret;
  if (typeof secret === 'string') {
    const match = ENV_TEMPLATE_RE.exec(secret);
    if (!match) return secret;
    const name = match[1];
    if (!name) return secret;
    const value = process.env[name];
    if (!value) throw new Error(`environment variable ${name} is not set`);
    return value;
  }

  const value = await getSecret(secret.id, secretPaths);
  if (value === undefined) throw new Error(`keystore has no entry for "${secret.id}"`);
  return value;
}
