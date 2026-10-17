// Social sign-in configuration (Google + GitHub OAuth clients), stored as rows
// in the generic `settings` table — same pattern as billing/config.ts. Client
// ids are plain (they are public: every authorize redirect carries one); the
// client secrets are AES-256-GCM encrypted like the Lemon Squeezy keys and
// never surface through the admin API. A provider is enabled iff BOTH of its
// rows exist.
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { settings } from '../db/schema';
import { decryptSecret, encryptSecret } from '../crypto';

export type OAuthProvider = 'google' | 'github';

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'github'];

export function isValidProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

const CLIENT_ID_KEYS: Record<OAuthProvider, string> = {
  google: 'oauth_google_client_id',
  github: 'oauth_github_client_id',
};
const CLIENT_SECRET_KEYS: Record<OAuthProvider, string> = {
  google: 'oauth_google_client_secret_enc',
  github: 'oauth_github_secret_enc',
};

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

async function plainSetting(env: Env, key: string): Promise<string | null> {
  try {
    const [row] = await getDb(env).select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function secretSetting(env: Env, key: string): Promise<string | null> {
  const stored = await plainSetting(env, key);
  if (!stored) return null;
  try {
    return await decryptSecret(env, stored);
  } catch {
    return null; // wrong ENCRYPTION_KEY / corrupted row — treat as unset
  }
}

/** The provider's credential pair, or null when either half is missing
 * (a half-configured provider must never half-work at the start endpoint). */
export async function getOAuthConfig(env: Env, provider: OAuthProvider): Promise<OAuthProviderConfig | null> {
  const [clientId, clientSecret] = await Promise.all([
    plainSetting(env, CLIENT_ID_KEYS[provider]),
    secretSetting(env, CLIENT_SECRET_KEYS[provider]),
  ]);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Merges a partial patch into the settings table. clientId/clientSecret
 * accept a string (secrets are re-encrypted on store) or null/'' to clear;
 * undefined fields are kept.
 */
export async function saveOAuthConfig(
  env: Env,
  patch: { google?: { clientId?: string | null; clientSecret?: string | null }; github?: { clientId?: string | null; clientSecret?: string | null } },
): Promise<void> {
  const db = getDb(env);
  const upsert = async (key: string, value: string | null) => {
    if (value == null) {
      await db.delete(settings).where(eq(settings.key, key));
      return;
    }
    await db
      .insert(settings)
      .values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } });
  };
  for (const provider of OAUTH_PROVIDERS) {
    const p = patch[provider];
    if (!p) continue;
    if (p.clientId !== undefined) await upsert(CLIENT_ID_KEYS[provider], p.clientId?.trim() || null);
    if (p.clientSecret !== undefined) {
      const secret = p.clientSecret?.trim() || null;
      await upsert(CLIENT_SECRET_KEYS[provider], secret ? await encryptSecret(env, secret) : null);
    }
  }
}

export type OAuthConfigStatus = {
  google: OAuthProviderStatus;
  github: OAuthProviderStatus;
};

export interface OAuthProviderStatus {
  configured: boolean;
  /** Client ids are public — returned in full so the operator can verify. */
  client_id: string | null;
  /** Exact value to register in the provider's console. */
  callback_url: string;
}

export function oauthConfigStatus(cfg: { google: OAuthProviderConfig | null; github: OAuthProviderConfig | null }, origin: string): OAuthConfigStatus {
  const status = (provider: OAuthProvider, config: OAuthProviderConfig | null): OAuthProviderStatus => ({
    configured: config !== null,
    client_id: config?.clientId ?? null,
    callback_url: `${origin}/api/portal/oauth/${provider}/callback`,
  });
  return {
    google: status('google', cfg.google),
    github: status('github', cfg.github),
  };
}
