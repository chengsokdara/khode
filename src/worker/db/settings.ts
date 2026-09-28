// Deployment-level settings (the `settings` key/value table): admin-controlled
// gateway behavior flags. Rate limiting + cache are read on EVERY request, so
// they are cached in the isolate for a short TTL. Writes (admin API) invalidate
// the cache immediately in the writing isolate; other isolates converge within
// the TTL.
//
// HISTORY (session 29): the keyless-native era is over — client-key
// enforcement, the keyless gate (official-build attestation) and the guest
// pool were all removed. /v1 requires a valid client key, always; onboarding
// is the device flow (/api/v1/device) or portal keys. Old settings rows
// (client_key_enforcement, keyless_gate_secret_hash, keyless_guest_user_id)
// are ignored orphans — no migration needed for removal.
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from './index';
import { settings } from './schema';

/** 'on' (absent = on) allows anonymous POST /api/portal/signup; 'off' closes it. */
export const PUBLIC_SIGNUP_KEY = 'public_signup';
export const PUBLIC_SIGNUP_ON = 'on';
export const PUBLIC_SIGNUP_OFF = 'off';
export type PublicSignup = typeof PUBLIC_SIGNUP_ON | typeof PUBLIC_SIGNUP_OFF;

/** M10 rate-limit rows. One row each; absent rows mean the defaults below. */
export const RATE_LIMIT_ENABLED_KEY = 'rate_limit_enabled';
export const RATE_LIMIT_KEY_RPM_KEY = 'rate_limit_key_rpm';
export const RATE_LIMIT_IP_RPM_KEY = 'rate_limit_ip_rpm';
export const RATE_LIMIT_ENABLED_ON = 'on';
export const RATE_LIMIT_ENABLED_OFF = 'off';
export type RateLimitEnabled = typeof RATE_LIMIT_ENABLED_ON | typeof RATE_LIMIT_ENABLED_OFF;
/** Defaults are the public-launch posture: generous for humans/coding agents,
 * tight enough that an open keyless gateway is not free compute for abuse. */
export const RATE_LIMIT_DEFAULT_KEY_RPM = 120;
export const RATE_LIMIT_DEFAULT_IP_RPM = 60;
/** Admin-configured values are bounded to keep the DO counters sane. */
export const RATE_LIMIT_RPM_MAX = 100_000;

/** M11 semantic-cache rows. The master switch is OFF by default (opt-in per
 * model/key turns it on); TTL bounds keep the cache_entries table sane. */
export const CACHE_ENABLED_KEY = 'cache_enabled';
export const CACHE_TTL_SECONDS_KEY = 'cache_ttl_seconds';
export const CACHE_ENABLED_ON = 'on';
export const CACHE_ENABLED_OFF = 'off';
export type CacheEnabled = typeof CACHE_ENABLED_ON | typeof CACHE_ENABLED_OFF;
export const CACHE_DEFAULT_TTL_SECONDS = 3600;
export const CACHE_TTL_MAX = 2_592_000; // 30 days

/** Opt-in auth-failure logging: when 'on', every 401 at the /v1 auth
 * middleware writes a minimal request_logs row (model '(unknown)', no
 * attribution, generic error text — never the attempted key/header). */
export const LOG_AUTH_FAILURES_KEY = 'log_auth_failures';
export const LOG_AUTH_FAILURES_ON = 'on';
export const LOG_AUTH_FAILURES_OFF = 'off';
export type LogAuthFailures = typeof LOG_AUTH_FAILURES_ON | typeof LOG_AUTH_FAILURES_OFF;

/** Cache TTL. Short on purpose: the admin toggles must converge quickly. */
const SETTINGS_TTL_MS = 5_000;

interface SettingsCache {
  at: number;
  rateLimit: RateLimitSettings;
  cache: CacheSettings;
  logAuthFailures: boolean;
}

export interface RateLimitSettings {
  enabled: boolean;
  keyRpm: number;
  ipRpm: number;
}

export interface CacheSettings {
  enabled: boolean;
  ttlSeconds: number;
}

let cache: SettingsCache | null = null;

/** Parses a stored rpm string; anything non-numeric falls back to the default. */
function normalizeRpm(value: string | null | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), RATE_LIMIT_RPM_MAX) : fallback;
}

/** Parses a stored TTL string; anything non-numeric falls back to the default. */
function normalizeTtl(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), CACHE_TTL_MAX) : CACHE_DEFAULT_TTL_SECONDS;
}

async function readSetting(env: Env, key: string): Promise<string | null> {
  try {
    const [row] = await getDb(env).select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSetting(env: Env, key: string, value: string): Promise<void> {
  await getDb(env)
    .insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } });
}

/**
 * One snapshot read for the cached gateway settings (M10 rate limits + M11
 * cache). Absent rows keep the deployment defaults (rate limiting ON at
 * 120 key / 60 IP rpm, cache OFF). A DB error fails OPEN for the rate
 * limiter (limits off) and the cache (off): a settings hiccup must never
 * brick the gateway. (Auth is NOT settings-dependent any more — every /v1
 * request needs a valid key, period.)
 */
async function loadSnapshot(env: Env): Promise<SettingsCache> {
  let rateLimit: RateLimitSettings = { enabled: true, keyRpm: RATE_LIMIT_DEFAULT_KEY_RPM, ipRpm: RATE_LIMIT_DEFAULT_IP_RPM };
  const cacheSettings: CacheSettings = { enabled: false, ttlSeconds: CACHE_DEFAULT_TTL_SECONDS };
  let logAuthFailures = false;
  try {
    const rows = await getDb(env).select({ key: settings.key, value: settings.value }).from(settings);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const enabled = byKey.get(RATE_LIMIT_ENABLED_KEY);
    rateLimit = {
      enabled: enabled !== RATE_LIMIT_ENABLED_OFF,
      keyRpm: normalizeRpm(byKey.get(RATE_LIMIT_KEY_RPM_KEY), RATE_LIMIT_DEFAULT_KEY_RPM),
      ipRpm: normalizeRpm(byKey.get(RATE_LIMIT_IP_RPM_KEY), RATE_LIMIT_DEFAULT_IP_RPM),
    };
    cacheSettings.enabled = byKey.get(CACHE_ENABLED_KEY) === CACHE_ENABLED_ON;
    cacheSettings.ttlSeconds = normalizeTtl(byKey.get(CACHE_TTL_SECONDS_KEY));
    logAuthFailures = byKey.get(LOG_AUTH_FAILURES_KEY) === LOG_AUTH_FAILURES_ON;
  } catch {
    // Table missing / DB hiccup → fail OPEN (limits off, cache off): a
    // settings hiccup must never brick the gateway.
  }
  return { at: Date.now(), rateLimit, cache: cacheSettings, logAuthFailures };
}

async function cachedSnapshot(env: Env): Promise<SettingsCache> {
  if (cache && Date.now() - cache.at < SETTINGS_TTL_MS) return cache;
  cache = await loadSnapshot(env);
  return cache;
}

/**
 * Reads the M10 rate-limit settings. Absent rows → enabled at the defaults.
 * Cached (the gateway reads it on EVERY request); a read error → limits off
 * (fail-open) until the cache expires.
 */
export async function getRateLimitSettings(env: Env): Promise<RateLimitSettings> {
  return (await cachedSnapshot(env)).rateLimit;
}

/** Persists rate-limit settings and invalidates this isolate's cache. */
export async function setRateLimitSettings(env: Env, patch: Partial<RateLimitSettings>): Promise<void> {
  if (patch.enabled !== undefined) await writeSetting(env, RATE_LIMIT_ENABLED_KEY, patch.enabled ? RATE_LIMIT_ENABLED_ON : RATE_LIMIT_ENABLED_OFF);
  if (patch.keyRpm !== undefined) await writeSetting(env, RATE_LIMIT_KEY_RPM_KEY, String(patch.keyRpm));
  if (patch.ipRpm !== undefined) await writeSetting(env, RATE_LIMIT_IP_RPM_KEY, String(patch.ipRpm));
  const current = await cachedSnapshot(env);
  cache = {
    at: Date.now(),
    rateLimit: {
      enabled: patch.enabled ?? current.rateLimit.enabled,
      keyRpm: patch.keyRpm ?? current.rateLimit.keyRpm,
      ipRpm: patch.ipRpm ?? current.rateLimit.ipRpm,
    },
    cache: current.cache,
    logAuthFailures: current.logAuthFailures,
  };
}

/**
 * Reads the M11 semantic-cache settings. Absent rows → master OFF at the
 * default TTL (caching is opt-in per model/key); cached with the other
 * gateway settings (5 s TTL); a read error → cache off (fail-open — a cache
 * outage must never brick the gateway, it just stops caching).
 */
export async function getCacheSettings(env: Env): Promise<CacheSettings> {
  return (await cachedSnapshot(env)).cache;
}

/** Persists cache settings and invalidates this isolate's cache. */
export async function setCacheSettings(env: Env, patch: Partial<CacheSettings>): Promise<void> {
  if (patch.enabled !== undefined) await writeSetting(env, CACHE_ENABLED_KEY, patch.enabled ? CACHE_ENABLED_ON : CACHE_ENABLED_OFF);
  if (patch.ttlSeconds !== undefined) await writeSetting(env, CACHE_TTL_SECONDS_KEY, String(patch.ttlSeconds));
  const current = await cachedSnapshot(env);
  cache = {
    at: Date.now(),
    rateLimit: current.rateLimit,
    cache: {
      enabled: patch.enabled ?? current.cache.enabled,
      ttlSeconds: patch.ttlSeconds ?? current.cache.ttlSeconds,
    },
    logAuthFailures: current.logAuthFailures,
  };
}

/** Reads the auth-failure logging flag. Absent row → 'off' (logging 401s is
 * opt-in); cached with the other gateway settings; fail-open = off. */
export async function getLogAuthFailures(env: Env): Promise<boolean> {
  return (await cachedSnapshot(env)).logAuthFailures;
}

/** Persists the auth-failure logging flag and invalidates this isolate's cache. */
export async function setLogAuthFailures(env: Env, value: LogAuthFailures): Promise<void> {
  await writeSetting(env, LOG_AUTH_FAILURES_KEY, value);
  const current = await cachedSnapshot(env);
  cache = {
    at: Date.now(),
    rateLimit: current.rateLimit,
    cache: current.cache,
    logAuthFailures: value === LOG_AUTH_FAILURES_ON,
  };
}

/**
 * Reads the public-signup flag. Absent row → 'on' (this is a public platform:
 * accounts are the point of M8); administrators can close it. NOT cached — portal
 * signups are rare and must not fail open on a DB hiccup (a failed read here
 * means 'off': signup is a low-traffic path, fail closed).
 */
export async function getPublicSignup(env: Env): Promise<PublicSignup> {
  const value = await readSetting(env, PUBLIC_SIGNUP_KEY);
  return value === PUBLIC_SIGNUP_OFF ? PUBLIC_SIGNUP_OFF : PUBLIC_SIGNUP_ON;
}

export async function setPublicSignup(env: Env, value: PublicSignup): Promise<void> {
  await writeSetting(env, PUBLIC_SIGNUP_KEY, value);
}

/** Free-models sync (models-sync.ts): JSON summary of the last run, written by
 * the daily cron and the admin "Sync now" button, read by the Models page.
 * NOT cached — one write per run, one read per page load. */
export const MODELS_SYNC_LAST_RUN_KEY = 'models_sync_last_run';

export async function getModelsSyncLastRun(env: Env): Promise<unknown> {
  const raw = await readSetting(env, MODELS_SYNC_LAST_RUN_KEY);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function setModelsSyncLastRun(env: Env, summary: unknown): Promise<void> {
  await writeSetting(env, MODELS_SYNC_LAST_RUN_KEY, JSON.stringify(summary));
}

/** Test hook: clears the in-memory cache (tests share the module across cases). */
export function resetSettingsCacheForTests(): void {
  cache = null;
}
