// MoR billing configuration (M8), stored as rows in the generic `settings`
// table. Non-secret identifiers are plain values; the Lemon Squeezy API key
// and webhook signing secret are AES-256-GCM encrypted like provider keys
// (only their last-4 hints ever surface through the admin API).
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { settings } from '../db/schema';
import { decryptSecret, encryptSecret } from '../crypto';

export const BILLING_PROVIDER = 'lemonsqueezy';

const LS_STORE_ID_KEY = 'ls_store_id';
const LS_VARIANT_ID_KEY = 'ls_variant_id';
const LS_API_KEY_ENC_KEY = 'ls_api_key_enc';
const LS_WEBHOOK_SECRET_ENC_KEY = 'ls_webhook_secret_enc';

export interface BillingConfig {
  storeId: string | null;
  variantId: string | null;
  /** Decrypted Lemon Squeezy API key (checkout creation). */
  apiKey: string | null;
  /** Decrypted webhook signing secret (X-Signature verification). */
  webhookSecret: string | null;
}

/** True when hosted checkouts can be created (webhook alone is not required). */
export function billingConfigured(cfg: BillingConfig): boolean {
  return Boolean(cfg.storeId && cfg.variantId && cfg.apiKey);
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

export async function getBillingConfig(env: Env): Promise<BillingConfig> {
  const [storeId, variantId, apiKey, webhookSecret] = await Promise.all([
    plainSetting(env, LS_STORE_ID_KEY),
    plainSetting(env, LS_VARIANT_ID_KEY),
    secretSetting(env, LS_API_KEY_ENC_KEY),
    secretSetting(env, LS_WEBHOOK_SECRET_ENC_KEY),
  ]);
  return { storeId, variantId, apiKey, webhookSecret };
}

/**
 * Merges a partial config patch into the settings table. Secret fields accept
 * a string (re-encrypt + store) or null (clear). Undefined fields are kept.
 */
export async function saveBillingConfig(
  env: Env,
  patch: { storeId?: string | null; variantId?: string | null; apiKey?: string | null; webhookSecret?: string | null },
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
  if (patch.storeId !== undefined) await upsert(LS_STORE_ID_KEY, patch.storeId?.trim() || null);
  if (patch.variantId !== undefined) await upsert(LS_VARIANT_ID_KEY, patch.variantId?.trim() || null);
  if (patch.apiKey !== undefined) {
    await upsert(LS_API_KEY_ENC_KEY, patch.apiKey ? await encryptSecret(env, patch.apiKey) : null);
  }
  if (patch.webhookSecret !== undefined) {
    await upsert(LS_WEBHOOK_SECRET_ENC_KEY, patch.webhookSecret ? await encryptSecret(env, patch.webhookSecret) : null);
  }
}

export async function billingConfigStatus(env: Env): Promise<{
  provider: string;
  store_id: string | null;
  variant_id: string | null;
  api_key_hint: string | null;
  webhook_secret_set: boolean;
  configured: boolean;
}> {
  const cfg = await getBillingConfig(env);
  return {
    provider: BILLING_PROVIDER,
    store_id: cfg.storeId,
    variant_id: cfg.variantId,
    api_key_hint: cfg.apiKey ? cfg.apiKey.slice(-4) : null,
    webhook_secret_set: Boolean(cfg.webhookSecret),
    configured: billingConfigured(cfg),
  };
}
