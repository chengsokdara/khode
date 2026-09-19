// /admin console API: login + session, overview, providers CRUD + test-connection,
// models CRUD. All mutations validate input server-side; provider API keys are
// encrypted at rest and never returned by the API (only a key_hint).
import { Hono } from 'hono';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql, sum } from 'drizzle-orm';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type { Adapter, Env } from '../env';
import { DEFAULT_BASES, joinAdapterUrl, joinUrl } from '../env';
import { KNOWN_ADAPTERS } from '../../shared/adapters';
import { parseAdapters } from '../routing';
import { getDb } from '../db';
import { apiKeys, balanceEntries, models, orgMembers, orgs, providers, requestLogs, sessions, userSessions, users } from '../db/schema';
import {
  CACHE_ENABLED_OFF,
  CACHE_ENABLED_ON,
  CACHE_TTL_MAX,
  CLIENT_KEY_ENFORCEMENT_OFF,
  CLIENT_KEY_ENFORCEMENT_ON,
  PUBLIC_SIGNUP_OFF,
  PUBLIC_SIGNUP_ON,
  RATE_LIMIT_DEFAULT_IP_RPM,
  RATE_LIMIT_DEFAULT_KEY_RPM,
  RATE_LIMIT_ENABLED_OFF,
  RATE_LIMIT_ENABLED_ON,
  RATE_LIMIT_RPM_MAX,
  getCacheSettings,
  getClientKeyEnforcement,
  getPublicSignup,
  getRateLimitSettings,
  setCacheSettings,
  setClientKeyEnforcement,
  setPublicSignup,
  setRateLimitSettings,
} from '../db/settings';
import { cacheStats, flushCache } from '../cache/store';
import { billingConfigStatus, saveBillingConfig } from '../billing/config';
import { decryptSecret, encryptSecret } from '../crypto';
import {
  SESSION_COOKIE,
  adminAuth,
  createSessionToken,
  generateClientKey,
  isSecureRequest,
  loginAllowed,
  revokeAllUserSessions,
  revokeSession,
  sessionIdForToken,
  timingSafeStrEqual,
} from '../auth';

type AdminEnv = { Bindings: Env };

export const adminApp = new Hono<AdminEnv>();

const KNOWN_CAPS = ['streaming', 'tools', 'vision', 'reasoning', 'json'] as const;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

const apiErr = (error: string) => ({ error });

// ------------------------------------------------------------------ helpers

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string | null | undefined): Record<string, string> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return null;
  }
}

/** Accepts an object or a JSON string; validates that values are strings. */
function normalizeHeaders(v: unknown): { err?: string; val?: Record<string, string> } {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return { err: 'default_headers must be a JSON object of string values' };
    }
  }
  if (obj === null) return { val: undefined };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { err: 'default_headers must be a JSON object of string values' };
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length > 32) return { err: 'default_headers supports at most 32 entries' };
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (!k.trim() || typeof val !== 'string') {
      return { err: 'default_headers must map string keys to string values' };
    }
    out[k] = val;
  }
  return { val: out };
}

/**
 * Validates a client-supplied `adapters` value (JSON array of upstream
 * dialects; ≥1 known adapter, deduped, order = gateway preference). Legacy
 * single-string `adapter` values are coerced to a one-element array.
 */
function normalizeAdapters(v: unknown): { err?: string; val?: Adapter[] } {
  let list: unknown[] | null = null;
  if (typeof v === 'string') {
    if (!(KNOWN_ADAPTERS as readonly string[]).includes(v)) {
      return { err: `adapter must be one of: ${KNOWN_ADAPTERS.join(', ')}` };
    }
    list = [v];
  } else if (Array.isArray(v)) {
    list = v;
  } else {
    return { err: `adapters must be an array from: ${KNOWN_ADAPTERS.join(', ')}` };
  }
  const seen = new Set<Adapter>();
  for (const x of list) {
    if (typeof x !== 'string' || !(KNOWN_ADAPTERS as readonly string[]).includes(x)) {
      return { err: `adapters must be an array from: ${KNOWN_ADAPTERS.join(', ')}` };
    }
    seen.add(x as Adapter);
  }
  if (seen.size === 0) return { err: 'adapters needs at least one adapter' };
  return { val: [...seen] };
}

type ProviderRow = typeof providers.$inferSelect;
type ProviderInsert = typeof providers.$inferInsert;
type ModelInsert = typeof models.$inferInsert;

function providerDto(
  r: {
    id: string;
    name: string;
    adapters?: string | null;
    baseUrl?: string | null;
    keyHint?: string | null;
    defaultHeaders?: string | null;
    timeoutMs?: number | null;
    enabled?: boolean;
  },
  modelCount = 0,
) {
  const adapters = parseAdapters(r.adapters ?? null);
  return {
    id: r.id,
    name: r.name,
    // Legacy scalar (first adapter) kept alongside the array for old clients.
    adapter: adapters[0] ?? 'openai',
    adapters,
    base_url: r.baseUrl,
    key_hint: r.keyHint,
    default_headers: parseJsonObject(r.defaultHeaders),
    timeout_ms: r.timeoutMs,
    enabled: Boolean(r.enabled),
    model_count: modelCount,
  };
}

// Shared select shape for models joined with their provider.
const modelFields = {
  id: models.id,
  providerId: models.providerId,
  providerName: providers.name,
  providerAdapters: providers.adapters,
  slug: models.slug,
  upstreamModel: models.upstreamModel,
  displayName: models.displayName,
  contextWindow: models.contextWindow,
  maxOutputTokens: models.maxOutputTokens,
  pricingInput: models.pricingInput,
  pricingOutput: models.pricingOutput,
  capabilities: models.capabilities,
  fallbacks: models.fallbacks,
  rateLimitRpm: models.rateLimitRpm,
  cacheEnabled: models.cacheEnabled,
  baseUrlOverride: models.baseUrlOverride,
  keyHint: models.keyHint,
  enabled: models.enabled,
  createdAt: models.createdAt,
};

type ModelJoinRow = {
  id: string;
  providerId: string;
  providerName: string | null;
  providerAdapters: string | null;
  slug: string;
  upstreamModel: string | null;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricingInput: number | null;
  pricingOutput: number | null;
  capabilities: string | null;
  fallbacks: string | null;
  rateLimitRpm: number | null;
  cacheEnabled: boolean | number;
  baseUrlOverride: string | null;
  keyHint: string | null;
  enabled: boolean | number;
  createdAt: number;
};

function modelDto(r: ModelJoinRow) {
  return {
    id: r.id,
    provider_id: r.providerId,
    provider_name: r.providerName ?? '',
    provider_adapters: parseAdapters(r.providerAdapters),
    // Legacy scalar (first adapter) kept alongside the array for old clients.
    provider_adapter: parseAdapters(r.providerAdapters)[0] ?? 'openai',
    slug: r.slug,
    upstream_model: r.upstreamModel,
    display_name: r.displayName,
    context_window: r.contextWindow,
    max_output_tokens: r.maxOutputTokens,
    pricing_input: r.pricingInput,
    pricing_output: r.pricingOutput,
    capabilities: parseJsonArray(r.capabilities),
    fallbacks: parseJsonArray(r.fallbacks),
    rate_limit_rpm: r.rateLimitRpm,
    cache_enabled: Boolean(r.cacheEnabled),
    base_url_override: r.baseUrlOverride,
    key_hint: r.keyHint,
    enabled: Boolean(r.enabled),
  };
}

// Validates shared model fields present in `body`; returns drizzle-ready values.
function buildModelPatch(body: Record<string, unknown>): { err?: string; val?: Partial<ModelInsert> } {
  const val: Partial<ModelInsert> = {};

  if (body.upstream_model !== undefined) {
    if (body.upstream_model === null) val.upstreamModel = null;
    else if (typeof body.upstream_model === 'string' && body.upstream_model.trim()) {
      val.upstreamModel = body.upstream_model.trim();
    } else return { err: 'upstream_model must be null or a non-empty string' };
  }
  if (body.display_name !== undefined) {
    if (body.display_name === null) val.displayName = null;
    else if (typeof body.display_name === 'string') val.displayName = body.display_name.trim() || null;
    else return { err: 'display_name must be null or a string' };
  }
  if (body.context_window !== undefined) {
    if (body.context_window === null) val.contextWindow = null;
    else if (typeof body.context_window === 'number' && Number.isInteger(body.context_window) && body.context_window >= 0) {
      val.contextWindow = body.context_window;
    } else return { err: 'context_window must be null or an integer ≥ 0' };
  }
  if (body.max_output_tokens !== undefined) {
    if (body.max_output_tokens === null) val.maxOutputTokens = null;
    else if (typeof body.max_output_tokens === 'number' && Number.isInteger(body.max_output_tokens) && body.max_output_tokens >= 0) {
      val.maxOutputTokens = body.max_output_tokens;
    } else return { err: 'max_output_tokens must be null or an integer ≥ 0' };
  }
  if (body.pricing_input !== undefined) {
    if (body.pricing_input === null) val.pricingInput = null;
    else if (typeof body.pricing_input === 'number' && Number.isFinite(body.pricing_input) && body.pricing_input >= 0 && body.pricing_input <= 10_000) {
      val.pricingInput = body.pricing_input;
    } else return { err: 'pricing_input must be null or 0–10000 (USD per 1M tokens)' };
  }
  if (body.pricing_output !== undefined) {
    if (body.pricing_output === null) val.pricingOutput = null;
    else if (typeof body.pricing_output === 'number' && Number.isFinite(body.pricing_output) && body.pricing_output >= 0 && body.pricing_output <= 10_000) {
      val.pricingOutput = body.pricing_output;
    } else return { err: 'pricing_output must be null or 0–10000 (USD per 1M tokens)' };
  }
  if (body.capabilities !== undefined) {
    if (body.capabilities === null) val.capabilities = null;
    else if (
      Array.isArray(body.capabilities) &&
      body.capabilities.every((x) => typeof x === 'string' && (KNOWN_CAPS as readonly string[]).includes(x))
    ) {
      val.capabilities = JSON.stringify(body.capabilities);
    } else return { err: `capabilities must be an array from: ${KNOWN_CAPS.join(', ')}` };
  }
  if (body.fallbacks !== undefined) {
    if (body.fallbacks === null) val.fallbacks = null;
    else if (
      Array.isArray(body.fallbacks) &&
      body.fallbacks.every((x) => typeof x === 'string') &&
      body.fallbacks.length <= 10
    ) {
      val.fallbacks = JSON.stringify(body.fallbacks);
    } else return { err: 'fallbacks must be an array of model slugs (max 10)' };
  }
  if (body.base_url_override !== undefined) {
    if (body.base_url_override === null || body.base_url_override === '') val.baseUrlOverride = null;
    else if (typeof body.base_url_override === 'string' && isHttpUrl(body.base_url_override.trim())) {
      val.baseUrlOverride = body.base_url_override.trim();
    } else return { err: 'base_url_override must be null or a valid http(s) URL' };
  }
  if (body.rate_limit_rpm !== undefined) {
    if (body.rate_limit_rpm === null) val.rateLimitRpm = null;
    else if (typeof body.rate_limit_rpm === 'number' && Number.isInteger(body.rate_limit_rpm) && body.rate_limit_rpm >= 1 && body.rate_limit_rpm <= RATE_LIMIT_RPM_MAX) {
      val.rateLimitRpm = body.rate_limit_rpm;
    } else return { err: `rate_limit_rpm must be null or an integer 1–${RATE_LIMIT_RPM_MAX} (requests/minute, global)` };
  }
  if (body.cache_enabled !== undefined) {
    if (typeof body.cache_enabled !== 'boolean') return { err: 'cache_enabled must be a boolean' };
    val.cacheEnabled = body.cache_enabled;
  }
  return { val };
}

// ------------------------------------------------------------------ session

adminApp.post('/login', async (c) => {
  if (!c.env.ADMIN_PASSWORD) {
    return c.json(apiErr('ADMIN_PASSWORD env var is not configured'), 500);
  }
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!loginAllowed('admin', ip)) {
    return c.json(apiErr('Too many attempts — try again in a minute.'), 429);
  }
  const body = await readJson(c);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password || !timingSafeStrEqual(password, c.env.ADMIN_PASSWORD)) {
    return c.json(apiErr('Wrong password'), 401);
  }
  const token = await createSessionToken(c.env);
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60,
    secure: isSecureRequest(c),
  });
  return c.json({ ok: true });
});

adminApp.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const sessionId = await sessionIdForToken(token);
  if (sessionId) {
    // The session-scoped playground key (M14) dies with its session.
    await getDb(c.env).delete(apiKeys).where(eq(apiKeys.playgroundSession, sessionId));
  }
  await revokeSession(c.env, token); // server-side revocation
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Everything below requires a valid session.
adminApp.use('*', adminAuth);

// ------------------------------------------------------------------ overview

adminApp.get('/overview', async (c) => {
  const db = getDb(c.env);
  const [pAll] = await db.select({ n: count() }).from(providers);
  const [pOn] = await db.select({ n: count() }).from(providers).where(eq(providers.enabled, true));
  const [mAll] = await db.select({ n: count() }).from(models);
  const [mOn] = await db.select({ n: count() }).from(models).where(eq(models.enabled, true));
  const [kAll] = await db.select({ n: count() }).from(apiKeys);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const [u] = await db
    .select({
      requests: count(),
      tokensIn: sum(requestLogs.tokensIn),
      tokensOut: sum(requestLogs.tokensOut),
      costUsd: sum(requestLogs.costUsd),
      cached: sql<number>`coalesce(sum(case when ${requestLogs.cacheHit} then 1 else 0 end), 0)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, dayAgo));
  return c.json({
    providers: pAll?.n ?? 0,
    providers_enabled: pOn?.n ?? 0,
    models: mAll?.n ?? 0,
    models_enabled: mOn?.n ?? 0,
    api_keys: kAll?.n ?? 0,
    usage_24h: {
      requests: u?.requests ?? 0,
      tokens_in: u?.tokensIn != null ? Number(u.tokensIn) : 0,
      tokens_out: u?.tokensOut != null ? Number(u.tokensOut) : 0,
      cost_usd: u?.costUsd != null ? Number(u.costUsd) : 0,
      cached: Number(u?.cached ?? 0),
    },
  });
});

// ------------------------------------------------------------------ settings
// Deployment-level gateway flags. Keyless-native default: client-key
// enforcement is OFF — the gateway serves anonymous /v1 traffic until an
// admin opts in (khode users then set KHATEWAY_API_KEY).

adminApp.get('/settings', async (c) => {
  const [enforcement, publicSignup, rateLimit, cache] = await Promise.all([
    getClientKeyEnforcement(c.env),
    getPublicSignup(c.env),
    getRateLimitSettings(c.env),
    getCacheSettings(c.env),
  ]);
  return c.json({
    client_key_enforcement: enforcement,
    public_signup: publicSignup,
    rate_limit_enabled: rateLimit.enabled ? RATE_LIMIT_ENABLED_ON : RATE_LIMIT_ENABLED_OFF,
    rate_limit_key_rpm: rateLimit.keyRpm,
    rate_limit_ip_rpm: rateLimit.ipRpm,
    cache_enabled: cache.enabled ? CACHE_ENABLED_ON : CACHE_ENABLED_OFF,
    cache_ttl_seconds: cache.ttlSeconds,
  });
});

adminApp.patch('/settings', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const patch: {
    enforcement?: string;
    signup?: string;
    rateLimit?: { enabled?: boolean; keyRpm?: number; ipRpm?: number };
    cache?: { enabled?: boolean; ttlSeconds?: number };
  } = {};
  if (body.client_key_enforcement !== undefined) {
    if (body.client_key_enforcement !== CLIENT_KEY_ENFORCEMENT_ON && body.client_key_enforcement !== CLIENT_KEY_ENFORCEMENT_OFF) {
      return c.json(apiErr(`client_key_enforcement must be '${CLIENT_KEY_ENFORCEMENT_ON}' or '${CLIENT_KEY_ENFORCEMENT_OFF}'`), 400);
    }
    patch.enforcement = body.client_key_enforcement;
  }
  if (body.public_signup !== undefined) {
    if (body.public_signup !== PUBLIC_SIGNUP_ON && body.public_signup !== PUBLIC_SIGNUP_OFF) {
      return c.json(apiErr(`public_signup must be '${PUBLIC_SIGNUP_ON}' or '${PUBLIC_SIGNUP_OFF}'`), 400);
    }
    patch.signup = body.public_signup;
  }
  if (body.rate_limit_enabled !== undefined) {
    if (body.rate_limit_enabled !== RATE_LIMIT_ENABLED_ON && body.rate_limit_enabled !== RATE_LIMIT_ENABLED_OFF) {
      return c.json(apiErr(`rate_limit_enabled must be '${RATE_LIMIT_ENABLED_ON}' or '${RATE_LIMIT_ENABLED_OFF}'`), 400);
    }
    patch.rateLimit = { ...(patch.rateLimit ?? {}), enabled: body.rate_limit_enabled === RATE_LIMIT_ENABLED_ON };
  }
  for (const field of ['rate_limit_key_rpm', 'rate_limit_ip_rpm'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > RATE_LIMIT_RPM_MAX) {
      return c.json(apiErr(`${field} must be an integer 1–${RATE_LIMIT_RPM_MAX} (requests/minute)`), 400);
    }
    patch.rateLimit = { ...(patch.rateLimit ?? {}), [field === 'rate_limit_key_rpm' ? 'keyRpm' : 'ipRpm']: v };
  }
  if (body.cache_enabled !== undefined) {
    if (body.cache_enabled !== CACHE_ENABLED_ON && body.cache_enabled !== CACHE_ENABLED_OFF) {
      return c.json(apiErr(`cache_enabled must be '${CACHE_ENABLED_ON}' or '${CACHE_ENABLED_OFF}'`), 400);
    }
    patch.cache = { ...(patch.cache ?? {}), enabled: body.cache_enabled === CACHE_ENABLED_ON };
  }
  if (body.cache_ttl_seconds !== undefined) {
    if (
      typeof body.cache_ttl_seconds !== 'number' ||
      !Number.isInteger(body.cache_ttl_seconds) ||
      body.cache_ttl_seconds < 1 ||
      body.cache_ttl_seconds > CACHE_TTL_MAX
    ) {
      return c.json(apiErr(`cache_ttl_seconds must be an integer 1–${CACHE_TTL_MAX} (30 days)`), 400);
    }
    patch.cache = { ...(patch.cache ?? {}), ttlSeconds: body.cache_ttl_seconds };
  }
  if (patch.enforcement !== undefined) await setClientKeyEnforcement(c.env, patch.enforcement as typeof CLIENT_KEY_ENFORCEMENT_ON | typeof CLIENT_KEY_ENFORCEMENT_OFF);
  if (patch.signup !== undefined) await setPublicSignup(c.env, patch.signup as typeof PUBLIC_SIGNUP_ON | typeof PUBLIC_SIGNUP_OFF);
  if (patch.rateLimit !== undefined) await setRateLimitSettings(c.env, patch.rateLimit);
  if (patch.cache !== undefined) await setCacheSettings(c.env, patch.cache);
  const [enforcement, publicSignup, rateLimit, cache] = await Promise.all([
    getClientKeyEnforcement(c.env),
    getPublicSignup(c.env),
    getRateLimitSettings(c.env),
    getCacheSettings(c.env),
  ]);
  return c.json({
    client_key_enforcement: enforcement,
    public_signup: publicSignup,
    rate_limit_enabled: rateLimit.enabled ? RATE_LIMIT_ENABLED_ON : RATE_LIMIT_ENABLED_OFF,
    rate_limit_key_rpm: rateLimit.keyRpm,
    rate_limit_ip_rpm: rateLimit.ipRpm,
    cache_enabled: cache.enabled ? CACHE_ENABLED_ON : CACHE_ENABLED_OFF,
    cache_ttl_seconds: cache.ttlSeconds,
  });
});

// ------------------------------------------------------- semantic cache (M11)
// Entry stats for the Settings card + the flush button. Hits/tokens come from
// request_logs (cache_hit rows, 24 h window) — the "savings" view.

adminApp.get('/cache', async (c) => {
  return c.json(await cacheStats(c.env));
});

adminApp.post('/cache/flush', async (c) => {
  const flushed = await flushCache(c.env);
  return c.json({ ok: true, flushed });
});

// ------------------------------------------------------------------ providers

adminApp.get('/providers', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: providers.id,
      name: providers.name,
      adapters: providers.adapters,
      baseUrl: providers.baseUrl,
      keyHint: providers.keyHint,
      defaultHeaders: providers.defaultHeaders,
      timeoutMs: providers.timeoutMs,
      enabled: providers.enabled,
      createdAt: providers.createdAt,
      modelCount: count(models.id),
    })
    .from(providers)
    .leftJoin(models, eq(models.providerId, providers.id))
    .groupBy(providers.id)
    .orderBy(asc(providers.createdAt));
  return c.json(
    rows.map((r) =>
      providerDto(
        {
          id: r.id,
          name: r.name,
          adapters: r.adapters,
          baseUrl: r.baseUrl,
          keyHint: r.keyHint,
          defaultHeaders: r.defaultHeaders,
          timeoutMs: r.timeoutMs,
          enabled: r.enabled,
        },
        r.modelCount,
      ),
    ),
  );
});

adminApp.post('/providers', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);

  // `adapters` (array) is the canonical field; legacy `adapter` (string) is
  // accepted and coerced so existing API scripts keep working.
  let adapters: Adapter[];
  if (body.adapters !== undefined) {
    const a = normalizeAdapters(body.adapters);
    if (a.err) return c.json(apiErr(a.err), 400);
    adapters = a.val!;
  } else {
    const a = normalizeAdapters(body.adapter);
    if (a.err) return c.json(apiErr(a.err), 400);
    adapters = a.val!;
  }

  let baseUrl: string | null = null;
  if (typeof body.base_url === 'string' && body.base_url.trim()) {
    const v = body.base_url.trim();
    if (!isHttpUrl(v)) return c.json(apiErr('base_url must be a valid http(s) URL'), 400);
    baseUrl = v;
  }

  let headers: Record<string, string> | null = null;
  if (body.default_headers !== undefined && body.default_headers !== null) {
    const h = normalizeHeaders(body.default_headers);
    if (h.err) return c.json(apiErr(h.err), 400);
    headers = h.val ?? null;
  }

  let timeoutMs = 60_000;
  if (typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms)) {
    timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(body.timeout_ms)));
  }

  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  let apiKeyEnc: string | null = null;
  let keyHint: string | null = null;
  if (apiKey) {
    if (apiKey.length > 4096) return c.json(apiErr('API key too long'), 400);
    try {
      apiKeyEnc = await encryptSecret(c.env, apiKey);
      keyHint = apiKey.slice(-4);
    } catch (e) {
      return c.json(apiErr(e instanceof Error ? e.message : 'Failed to encrypt API key'), 500);
    }
  }

  const rec: ProviderInsert = {
    id: crypto.randomUUID(),
    name,
    adapters: JSON.stringify(adapters),
    baseUrl,
    apiKeyEnc,
    keyHint,
    defaultHeaders: headers ? JSON.stringify(headers) : null,
    timeoutMs,
    enabled: body.enabled !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await getDb(c.env).insert(providers).values(rec);
  return c.json(providerDto(rec, 0), 201);
});

adminApp.patch('/providers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const db = getDb(c.env);
  const [existing] = await db.select().from(providers).where(eq(providers.id, id));
  if (!existing) return c.json(apiErr('Provider not found'), 404);

  const patch: Partial<ProviderInsert> = { updatedAt: Date.now() };

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);
    patch.name = name;
  }
  if (body.adapters !== undefined || body.adapter !== undefined) {
    const a = normalizeAdapters(body.adapters !== undefined ? body.adapters : body.adapter);
    if (a.err) return c.json(apiErr(a.err), 400);
    patch.adapters = JSON.stringify(a.val);
  }
  if (body.base_url !== undefined) {
    if (body.base_url === null || body.base_url === '') patch.baseUrl = null;
    else if (typeof body.base_url === 'string' && isHttpUrl(body.base_url.trim())) patch.baseUrl = body.base_url.trim();
    else return c.json(apiErr('base_url must be null or a valid http(s) URL'), 400);
  }
  if (body.default_headers !== undefined) {
    if (body.default_headers === null) patch.defaultHeaders = null;
    else {
      const h = normalizeHeaders(body.default_headers);
      if (h.err) return c.json(apiErr(h.err), 400);
      patch.defaultHeaders = h.val ? JSON.stringify(h.val) : null;
    }
  }
  if (body.timeout_ms !== undefined) {
    if (typeof body.timeout_ms !== 'number' || !Number.isFinite(body.timeout_ms)) {
      return c.json(apiErr('timeout_ms must be a number'), 400);
    }
    patch.timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(body.timeout_ms)));
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    patch.enabled = body.enabled;
  }
  if (body.api_key !== undefined) {
    if (body.api_key === null || body.api_key === '') {
      patch.apiKeyEnc = null;
      patch.keyHint = null;
    } else if (typeof body.api_key === 'string') {
      const key = body.api_key.trim();
      if (!key) {
        patch.apiKeyEnc = null;
        patch.keyHint = null;
      } else if (key.length > 4096) {
        return c.json(apiErr('API key too long'), 400);
      } else {
        try {
          patch.apiKeyEnc = await encryptSecret(c.env, key);
          patch.keyHint = key.slice(-4);
        } catch (e) {
          return c.json(apiErr(e instanceof Error ? e.message : 'Failed to encrypt API key'), 500);
        }
      }
    } else return c.json(apiErr('api_key must be a string or null'), 400);
  }

  await db.update(providers).set(patch).where(eq(providers.id, id));
  const [updated] = await db.select().from(providers).where(eq(providers.id, id));
  return c.json(providerDto(updated));
});

adminApp.delete('/providers/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [existing] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, id));
  if (!existing) return c.json(apiErr('Provider not found'), 404);
  await db.batch([
    db.delete(models).where(eq(models.providerId, id)),
    db.delete(providers).where(eq(providers.id, id)),
  ]);
  return c.json({ ok: true });
});

adminApp.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [p] = await db.select().from(providers).where(eq(providers.id, id));
  if (!p) return c.json(apiErr('Provider not found'), 404);

  let key: string | null = null;
  try {
    key = await decryptSecret(c.env, p.apiKeyEnc);
  } catch (e) {
    return c.json({
      ok: false,
      status: null,
      latency_ms: null,
      model_count: null,
      error: `Stored API key unreadable: ${e instanceof Error ? e.message : 'decrypt failed'}`,
    });
  }

  // Probes every declared adapter (dual-dialect providers get one probe per
  // dialect, since a vendor can serve one while the other misbehaves); the
  // aggregate is ok only when at least one adapter answers.
  const adapters = parseAdapters(p.adapters);
  const timeout = Math.min(15_000, Math.max(1_500, p.timeoutMs ?? 8_000));
  let best: { ok: boolean; status: number | null; latency_ms: number; model_count: number | null; error: string | null } | null = null;

  for (const adapter of adapters.length ? adapters : (['openai'] as Adapter[])) {
    const isAnthropic = adapter === 'anthropic';
    const isGemini = adapter === 'gemini';
    const base = (p.baseUrl || DEFAULT_BASES[adapter]).replace(/\/+$/, '');
    const url = joinAdapterUrl(base, adapter, isAnthropic ? '/v1/models' : '/models');
    const headers: Record<string, string> = {
      ...(parseJsonObject(p.defaultHeaders) ?? {}),
      ...(isAnthropic
        ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
        : isGemini
          ? { 'x-goog-api-key': key ?? '' }
          : key
            ? { Authorization: `Bearer ${key}` }
            : {}),
    };

    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const errBody = (await res.text().catch(() => '')).slice(0, 240);
        const attempt = { ok: false, status: res.status as number | null, latency_ms: latencyMs, model_count: null, error: errBody || `HTTP ${res.status}` };
        if (!best || (attempt.status ?? 0) < (best.status ?? 0)) best = attempt;
        continue;
      }
      let modelCount: number | null = null;
      try {
        const j = (await res.json()) as { data?: unknown[]; models?: unknown[] };
        if (Array.isArray(j?.data)) modelCount = j.data.length;
        else if (Array.isArray(j?.models)) modelCount = j.models.length; // gemini listing
      } catch {
        // non-JSON success still counts as reachable
      }
      best = { ok: true, status: res.status, latency_ms: latencyMs, model_count: modelCount, error: null };
      break; // first healthy adapter wins
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = e instanceof Error ? e.message : 'network error';
      const attempt = { ok: false, status: null, latency_ms: latencyMs, model_count: null, error: /abort|timeout/i.test(msg) ? `Timed out after ${timeout} ms` : msg };
      if (!best) best = attempt;
    }
  }

  return c.json(best!);
});

// ------------------------------------------------- upstream model discovery

/** One upstream model as offered for import into the Khateway catalog. */
interface UpstreamModel {
  id: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}
const UPSTREAM_MODELS_MAX = 500;

/**
 * Probes the upstream /models listing (openai-compatible: GET /models;
 * anthropic: GET /v1/models) with the provider's effective base URL,
 * credentials and default headers, and normalizes the result into
 * UpstreamModel entries. Model discovery is best-effort: entries with
 * unusable ids are skipped, everything else passes through as offered.
 */
async function listUpstreamModels(env: Env, p: ProviderRow): Promise<{ ok: true; models: UpstreamModel[] } | { ok: false; error: string; status: number | null }> {
  let key: string | null = null;
  try {
    key = await decryptSecret(env, p.apiKeyEnc);
  } catch (e) {
    return { ok: false, status: null, error: `Stored API key unreadable: ${e instanceof Error ? e.message : 'decrypt failed'}` };
  }
  if (!p.baseUrl) {
    return { ok: false, status: null, error: 'No base URL configured — set one to discover models.' };
  }

  const adapters = parseAdapters(p.adapters);
  const adapter: Adapter = adapters[0] ?? 'openai';
  const isAnthropic = adapter === 'anthropic';
  const isGemini = adapter === 'gemini';
  const base = p.baseUrl.replace(/\/+$/, '');
  const url = joinAdapterUrl(base, adapter, isAnthropic ? '/v1/models' : '/models');
  const headers: Record<string, string> = {
    ...(parseJsonObject(p.defaultHeaders) ?? {}),
    ...(isAnthropic
      ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
      : isGemini
        ? { 'x-goog-api-key': key ?? '' }
        : key
          ? { Authorization: `Bearer ${key}` }
          : {}),
  };

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(1_500, p.timeoutMs ?? 8_000))),
    });
    if (!res.ok) {
      const errBody = (await res.text().catch(() => '')).slice(0, 240);
      return { ok: false, status: res.status, error: errBody || `HTTP ${res.status}` };
    }
    if (isGemini) {
      // Gemini listing: {models:[{name:'models/gemini-2.5-flash', displayName,
      // inputTokenLimit, outputTokenLimit, supportedGenerationMethods}]} — ids
      // are the stripped names; non-generateContent entries (embeddings, tts…)
      // are skipped since the gateway only routes chat generation.
      const body = (await res.json().catch(() => null)) as { models?: unknown } | null;
      if (!body || !Array.isArray(body.models)) {
        return { ok: false, status: res.status, error: 'Upstream returned an unexpected /models response (no models array).' };
      }
      const models: UpstreamModel[] = [];
      const seen = new Set<string>();
      for (const raw of body.models) {
        if (!raw || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        const id = typeof m.name === 'string' ? m.name.trim().replace(/^models\//, '') : '';
        if (!id || seen.has(id)) continue;
        const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : null;
        if (methods && !methods.includes('generateContent')) continue;
        seen.add(id);
        const ctx = typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null;
        const out = typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : null;
        const name = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : null;
        models.push({ id, displayName: name, contextWindow: ctx, maxOutputTokens: out });
        if (models.length >= UPSTREAM_MODELS_MAX) break;
      }
      return { ok: true, models };
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      return { ok: false, status: res.status, error: 'Upstream returned an unexpected /models response (no data array).' };
    }
    const models: UpstreamModel[] = [];
    const seen = new Set<string>();
    for (const raw of body.data) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ctx = typeof m.context_window === 'number' ? m.context_window : typeof m.context_length === 'number' ? m.context_length : null;
      const out = typeof m.max_output_tokens === 'number' ? m.max_output_tokens : null;
      const name = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : null;
      models.push({ id, displayName: name, contextWindow: ctx, maxOutputTokens: out });
      if (models.length >= UPSTREAM_MODELS_MAX) break;
    }
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    return { ok: false, status: null, error: /abort|timeout/i.test(msg) ? 'Timed out fetching models' : msg };
  }
}

/**
 * Model discovery for a SAVED provider (uses its stored, encrypted key).
 * Returns the upstream's /models list normalized for the import picker.
 */
adminApp.post('/providers/:id/fetch-models', async (c) => {
  const db = getDb(c.env);
  const [p] = await db.select().from(providers).where(eq(providers.id, c.req.param('id')));
  if (!p) return c.json(apiErr('Provider not found'), 404);
  const res = await listUpstreamModels(c.env, p);
  if (!res.ok) return c.json({ error: res.error, status: res.status }, 502);
  return c.json({
    models: res.models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
    })),
  });
});

/**
 * Model discovery for the ADD form (provider not saved yet): accepts the same
 * body as POST /providers and probes with those values. The key (if any) is
 * used in-memory only — never persisted.
 */
adminApp.post('/providers/fetch-models', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  let baseUrl: string | null = null;
  if (typeof body.base_url === 'string' && body.base_url.trim()) {
    const v = body.base_url.trim();
    if (!isHttpUrl(v)) return c.json(apiErr('base_url must be a valid http(s) URL'), 400);
    baseUrl = v;
  }

  const headers = body.default_headers !== undefined && body.default_headers !== null ? normalizeHeaders(body.default_headers) : { val: undefined };
  if (headers.err) return c.json(apiErr(headers.err), 400);

  let adapters: Adapter[] = [];
  if (body.adapters !== undefined || body.adapter !== undefined) {
    const a = normalizeAdapters(body.adapters !== undefined ? body.adapters : body.adapter);
    if (a.err) return c.json(apiErr(a.err), 400);
    adapters = a.val!;
  }
  if (!baseUrl && adapters.length > 1) {
    return c.json(apiErr('Pick ONE adapter for discovery, or set a base_url — the two adapter defaults differ.'), 400);
  }
  const adapter: Adapter = adapters[0] ?? 'openai';

  // Synthetic ProviderRow shaped for listUpstreamModels (nothing is stored).
  const synthetic: ProviderRow = {
    id: 'unsaved',
    name: typeof body.name === 'string' ? body.name : '(unsaved provider)',
    adapters: JSON.stringify(adapters.length ? adapters : [adapter]),
    baseUrl,
    apiKeyEnc: null,
    keyHint: null,
    defaultHeaders: headers.val ? JSON.stringify(headers.val) : null,
    timeoutMs: typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms) ? Math.min(120_000, Math.max(1_000, Math.round(body.timeout_ms))) : null,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Encrypt the in-memory key so listUpstreamModels can decrypt it uniformly.
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  let apiKeyEnc: string | null = null;
  if (apiKey) {
    if (apiKey.length > 4096) return c.json(apiErr('API key too long'), 400);
    try {
      apiKeyEnc = await encryptSecret(c.env, apiKey);
    } catch (e) {
      return c.json(apiErr(e instanceof Error ? e.message : 'Failed to process API key'), 500);
    }
  }
  synthetic.apiKeyEnc = apiKeyEnc;

  const res = await listUpstreamModels(c.env, synthetic);
  if (!res.ok) return c.json({ error: res.error, status: res.status }, 502);
  return c.json({
    models: res.models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
    })),
  });
});

/**
 * Bulk model import: creates one model per slug for a saved provider.
 * Slug rules match POST /models; already-existing slugs are skipped (and
 * reported) so re-running an import never duplicates. All-or-nothing per
 * entry; the response reports created/skipped lists.
 */
adminApp.post('/providers/:id/import-models', async (c) => {
  const db = getDb(c.env);
  const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, c.req.param('id')));
  if (!p) return c.json(apiErr('Provider not found'), 404);
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const ids = Array.isArray(body.model_ids) ? body.model_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
  if (ids.length === 0) return c.json(apiErr('model_ids must be a non-empty array of upstream model ids'), 400);
  if (ids.length > 100) return c.json(apiErr('Import at most 100 models at a time'), 400);
  const unique = [...new Set(ids.map((x) => x.trim()))];

  const created: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of unique) {
    if (!SLUG_RE.test(id)) {
      skipped.push({ id, reason: 'id contains characters outside the slug alphabet (letters, digits, dots, dashes, underscores)' });
      continue;
    }
    const [dup] = await db.select({ id: models.id }).from(models).where(eq(models.slug, id));
    if (dup) {
      skipped.push({ id, reason: 'slug already in use' });
      continue;
    }
    const val: ModelInsert = {
      id: crypto.randomUUID(),
      providerId: p.id,
      slug: id,
      upstreamModel: id,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.insert(models).values(val);
    created.push(id);
  }
  return c.json({ created, skipped }, 201);
});

// ------------------------------------------------------------------ models

adminApp.get('/models', async (c) => {
  const providerId = c.req.query('provider_id');
  const db = getDb(c.env);
  const rows = await db
    .select(modelFields)
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(providerId ? eq(models.providerId, providerId) : undefined)
    .orderBy(desc(models.createdAt));
  return c.json(rows.map((r) => modelDto(r)));
});

adminApp.post('/models', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const providerId = typeof body.provider_id === 'string' ? body.provider_id : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!SLUG_RE.test(slug)) {
    return c.json(apiErr('Slug must be 1–120 chars: letters, digits, dots, dashes, underscores'), 400);
  }
  const db = getDb(c.env);

  const [provider] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, providerId));
  if (!provider) return c.json(apiErr('provider_id does not reference an existing provider'), 400);

  const [dup] = await db.select({ id: models.id }).from(models).where(eq(models.slug, slug));
  if (dup) return c.json(apiErr(`Slug "${slug}" is already in use`), 409);

  const patch = buildModelPatch(body);
  if (patch.err) return c.json(apiErr(patch.err), 400);
  const val: ModelInsert = {
    ...(patch.val ?? {}),
    id: crypto.randomUUID(),
    providerId,
    slug,
    upstreamModel: patch.val?.upstreamModel ?? slug,
    enabled: body.enabled !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.insert(models).values(val);

  const [row] = await db
    .select(modelFields)
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.id, val.id));
  return c.json(modelDto(row), 201);
});

adminApp.patch('/models/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const db = getDb(c.env);
  const [existing] = await db.select().from(models).where(eq(models.id, id));
  if (!existing) return c.json(apiErr('Model not found'), 404);

  const patch: Partial<ModelInsert> = { updatedAt: Date.now() };

  if (body.provider_id !== undefined) {
    if (typeof body.provider_id !== 'string') return c.json(apiErr('provider_id must be a string'), 400);
    const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, body.provider_id));
    if (!p) return c.json(apiErr('provider_id does not reference an existing provider'), 400);
    patch.providerId = body.provider_id;
  }
  if (body.slug !== undefined) {
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!SLUG_RE.test(slug)) return c.json(apiErr('Invalid slug'), 400);
    const [dup] = await db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.slug, slug), ne(models.id, id)));
    if (dup) return c.json(apiErr(`Slug "${slug}" is already in use`), 409);
    patch.slug = slug;
  }
  if (body.api_key_override !== undefined) {
    if (body.api_key_override === null || body.api_key_override === '') {
      patch.apiKeyOverrideEnc = null;
      patch.keyHint = null;
    } else if (typeof body.api_key_override === 'string') {
      const key = body.api_key_override.trim();
      if (key.length > 4096) return c.json(apiErr('API key too long'), 400);
      try {
        patch.apiKeyOverrideEnc = await encryptSecret(c.env, key);
        patch.keyHint = key.slice(-4);
      } catch (e) {
        return c.json(apiErr(e instanceof Error ? e.message : 'Failed to encrypt API key'), 500);
      }
    } else return c.json(apiErr('api_key_override must be a string or null'), 400);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    patch.enabled = body.enabled;
  }

  const shared = buildModelPatch(body);
  if (shared.err) return c.json(apiErr(shared.err), 400);
  Object.assign(patch, shared.val ?? {});

  await db.update(models).set(patch).where(eq(models.id, id));
  const [row] = await db
    .select(modelFields)
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.id, id));
  if (!row) return c.json(apiErr('Model not found'), 404);
  return c.json(modelDto(row));
});

adminApp.delete('/models/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [existing] = await db.select({ id: models.id }).from(models).where(eq(models.id, id));
  if (!existing) return c.json(apiErr('Model not found'), 404);
  await db.delete(models).where(eq(models.id, id));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ playground
// M14 — the admin playground chats against the REAL /v1 gateway, so its
// requests exercise the same auth/gates/logging path as any client. Each
// admin session gets one ephemeral client key (`playground_session` = sha256
// of the session token): no spend cap, no model restrictions, hidden from the
// API Keys page. The raw key rides only in the mint response (hash-only
// storage) — every mint rotates the session's key, so a page reload
// invalidates the previous one. Keys die with their session (logout deletes
// them) or lazily when the session row disappears/expires (sweep below).

adminApp.post('/playground/key', async (c) => {
  const sessionId = await sessionIdForToken(getCookie(c, SESSION_COOKIE));
  if (!sessionId) return c.json(apiErr('Unauthorized'), 401);
  const db = getDb(c.env);
  const now = Date.now();

  // Sweep playground keys whose session row is gone or expired. Logout deletes
  // its own key; this catches expired and abandoned sessions.
  const pgKeys = await db
    .select({ id: apiKeys.id, expiresAt: sessions.expiresAt })
    .from(apiKeys)
    .leftJoin(sessions, eq(sessions.id, apiKeys.playgroundSession))
    .where(isNotNull(apiKeys.playgroundSession));
  const staleIds = pgKeys.filter((k) => k.expiresAt == null || k.expiresAt <= now).map((k) => k.id);
  if (staleIds.length) await db.delete(apiKeys).where(inArray(apiKeys.id, staleIds));

  await db.delete(apiKeys).where(eq(apiKeys.playgroundSession, sessionId)); // rotate
  const { raw, prefix, hash } = await generateClientKey();
  const rec: ApiKeyInsert = {
    id: crypto.randomUUID(),
    name: 'Playground',
    keyHash: hash,
    keyPrefix: prefix,
    playgroundSession: sessionId,
    spendLimitUsd: null,
    allowedModels: null,
    enabled: true,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await db.insert(apiKeys).values(rec);
  // The raw key rides ONLY in this response — same one-time-reveal contract
  // as POST /api-keys.
  return c.json({ id: rec.id, name: 'Playground', key_prefix: prefix, key: raw }, 201);
});

// ------------------------------------------------------------------ api keys
// Client API keys for the /v1 gateway (M7). The raw key (`khat-…`) exists only
// in the create response — the DB stores its sha-256 hash and a short prefix
// for the UI. Logs are kept when a key is deleted (historical record).
// Session-scoped playground keys (M14) are derived state of an admin session —
// not listed here; they are created/revoked by /admin/playground/key + logout.

type ApiKeyInsert = typeof apiKeys.$inferInsert;

function apiKeyDto(
  r: {
    id: string;
    name: string;
    keyPrefix: string;
    userId?: string | null;
    orgId?: string | null;
    spendLimitUsd?: number | null;
    rateLimitRpm?: number | null;
    cacheEnabled?: boolean | number;
    allowedModels?: string | null;
    enabled?: boolean | number;
    lastUsedAt?: number | null;
    createdAt: number;
  },
  spentUsd = 0,
  requestCount = 0,
  userEmail: string | null = null,
  orgName: string | null = null,
) {
  return {
    id: r.id,
    name: r.name,
    key_prefix: r.keyPrefix,
    user_id: r.userId ?? null,
    user_email: userEmail,
    org_id: r.orgId ?? null,
    org_name: orgName,
    spend_limit_usd: r.spendLimitUsd ?? null,
    rate_limit_rpm: r.rateLimitRpm ?? null,
    cache_enabled: Boolean(r.cacheEnabled),
    allowed_models: parseJsonArray(r.allowedModels),
    enabled: Boolean(r.enabled),
    last_used_at: r.lastUsedAt ?? null,
    created_at: r.createdAt,
    spent_usd: spentUsd,
    request_count: requestCount,
  };
}

/** Per-key usage aggregates (spend + request count) from request_logs. */
async function keyUsage(db: ReturnType<typeof getDb>, id: string): Promise<{ spentUsd: number; requests: number }> {
  const [agg] = await db
    .select({ spent: sum(requestLogs.costUsd), requests: count() })
    .from(requestLogs)
    .where(eq(requestLogs.apiKeyId, id));
  return { spentUsd: agg?.spent != null ? Number(agg.spent) : 0, requests: agg?.requests ?? 0 };
}

adminApp.get('/api-keys', async (c) => {
  const rows = await getDb(c.env)
    .select({ key: apiKeys, userEmail: users.email, orgName: orgs.name })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(orgs, eq(apiKeys.orgId, orgs.id))
    .where(isNull(apiKeys.playgroundSession)) // M14 playground keys are session-derived, not managed here
    .orderBy(asc(apiKeys.createdAt));
  const out = [];
  for (const r of rows) {
    const usage = await keyUsage(getDb(c.env), r.key.id);
    out.push(apiKeyDto(r.key, usage.spentUsd, usage.requests, r.userEmail ?? null, r.orgName ?? null));
  }
  return c.json(out);
});

adminApp.post('/api-keys', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);

  let spendLimitUsd: number | null = null;
  if (body.spend_limit_usd !== undefined && body.spend_limit_usd !== null) {
    if (typeof body.spend_limit_usd !== 'number' || !Number.isFinite(body.spend_limit_usd) || body.spend_limit_usd < 0 || body.spend_limit_usd > 1_000_000) {
      return c.json(apiErr('spend_limit_usd must be null or a number 0–1,000,000'), 400);
    }
    spendLimitUsd = body.spend_limit_usd;
  }

  let rateLimitRpm: number | null = null;
  if (body.rate_limit_rpm !== undefined && body.rate_limit_rpm !== null) {
    if (typeof body.rate_limit_rpm !== 'number' || !Number.isInteger(body.rate_limit_rpm) || body.rate_limit_rpm < 1 || body.rate_limit_rpm > RATE_LIMIT_RPM_MAX) {
      return c.json(apiErr(`rate_limit_rpm must be null or an integer 1–${RATE_LIMIT_RPM_MAX} (requests/minute)`), 400);
    }
    rateLimitRpm = body.rate_limit_rpm;
  }

  const cacheEnabled = body.cache_enabled === true;

  let allowedModels: string[] | null = null;
  if (body.allowed_models !== undefined && body.allowed_models !== null) {
    if (
      !Array.isArray(body.allowed_models) ||
      body.allowed_models.length > 100 ||
      !body.allowed_models.every((x) => typeof x === 'string' && x.trim())
    ) {
      return c.json(apiErr('allowed_models must be an array of model slugs (max 100)'), 400);
    }
    allowedModels = (body.allowed_models as string[]).map((x) => x.trim());
  }

  const { raw, prefix, hash } = await generateClientKey();
  const rec: ApiKeyInsert = {
    id: crypto.randomUUID(),
    name,
    keyHash: hash,
    keyPrefix: prefix,
    spendLimitUsd,
    rateLimitRpm,
    cacheEnabled,
    allowedModels: allowedModels ? JSON.stringify(allowedModels) : null,
    enabled: body.enabled !== false,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await getDb(c.env).insert(apiKeys).values(rec);
  // The raw key rides ONLY in this response — it is never stored or logged.
  return c.json({ ...apiKeyDto(rec), key: raw }, 201);
});

adminApp.patch('/api-keys/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const db = getDb(c.env);
  const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!existing) return c.json(apiErr('API key not found'), 404);

  const patch: Partial<ApiKeyInsert> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);
    patch.name = name;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    patch.enabled = body.enabled;
  }
  if (body.spend_limit_usd !== undefined) {
    if (body.spend_limit_usd === null) patch.spendLimitUsd = null;
    else if (typeof body.spend_limit_usd === 'number' && Number.isFinite(body.spend_limit_usd) && body.spend_limit_usd >= 0 && body.spend_limit_usd <= 1_000_000) {
      patch.spendLimitUsd = body.spend_limit_usd;
    } else return c.json(apiErr('spend_limit_usd must be null or a number 0–1,000,000'), 400);
  }
  if (body.rate_limit_rpm !== undefined) {
    if (body.rate_limit_rpm === null) patch.rateLimitRpm = null;
    else if (typeof body.rate_limit_rpm === 'number' && Number.isInteger(body.rate_limit_rpm) && body.rate_limit_rpm >= 1 && body.rate_limit_rpm <= RATE_LIMIT_RPM_MAX) {
      patch.rateLimitRpm = body.rate_limit_rpm;
    } else return c.json(apiErr(`rate_limit_rpm must be null or an integer 1–${RATE_LIMIT_RPM_MAX} (requests/minute)`), 400);
  }
  if (body.allowed_models !== undefined) {
    if (body.allowed_models === null) patch.allowedModels = null;
    else if (
      Array.isArray(body.allowed_models) &&
      body.allowed_models.length <= 100 &&
      body.allowed_models.every((x) => typeof x === 'string' && x.trim())
    ) {
      patch.allowedModels = JSON.stringify((body.allowed_models as string[]).map((x) => x.trim()));
    } else return c.json(apiErr('allowed_models must be null or an array of model slugs (max 100)'), 400);
  }
  if (body.cache_enabled !== undefined) {
    if (typeof body.cache_enabled !== 'boolean') return c.json(apiErr('cache_enabled must be a boolean'), 400);
    patch.cacheEnabled = body.cache_enabled;
  }

  if (Object.keys(patch).length === 0) {
    const usage = await keyUsage(db, id);
    return c.json(apiKeyDto(existing, usage.spentUsd, usage.requests));
  }

  await db.update(apiKeys).set(patch).where(eq(apiKeys.id, id));
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  const usage = await keyUsage(db, id);
  return c.json(apiKeyDto(updated, usage.spentUsd, usage.requests));
});

adminApp.delete('/api-keys/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id));
  if (!existing) return c.json(apiErr('API key not found'), 404);
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ users
// Portal accounts (M8). Admin view is global: list, adjust the prepaid
// balance (ledgered as an `adjustment` entry), enable/disable, delete.
// Platform admin stays global — org scoping arrives with M9.

type UserInsert = typeof users.$inferSelect;

function userDto(r: UserInsert, keyCount = 0) {
  return {
    id: r.id,
    email: r.email,
    balance_usd: r.balanceUsdMicros / 1e6,
    enabled: Boolean(r.enabled),
    key_count: keyCount,
    created_at: r.createdAt,
  };
}

adminApp.get('/users', async (c) => {
  const rows = await getDb(c.env)
    .select({ user: users, keyCount: count(apiKeys.id) })
    .from(users)
    .leftJoin(apiKeys, eq(apiKeys.userId, users.id))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt));
  return c.json(rows.map((r) => userDto(r.user, r.keyCount)));
});

adminApp.patch('/users/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const db = getDb(c.env);
  const [existing] = await db.select().from(users).where(eq(users.id, id));
  if (!existing) return c.json(apiErr('User not found'), 404);

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    if (body.enabled !== Boolean(existing.enabled)) {
      await db.update(users).set({ enabled: body.enabled, updatedAt: Date.now() }).where(eq(users.id, id));
      // Disabling a user must end their live sessions immediately.
      if (!body.enabled) await revokeAllUserSessions(c.env, id);
    }
  }

  if (body.balance_adjust_usd !== undefined) {
    const adj = body.balance_adjust_usd;
    if (typeof adj !== 'number' || !Number.isFinite(adj) || adj === 0 || Math.abs(adj) > 1_000_000) {
      return c.json(apiErr('balance_adjust_usd must be a non-zero number within ±1,000,000'), 400);
    }
    const micros = Math.round(adj * 1e6);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null;
    await db.batch([
      db.insert(balanceEntries).values({
        id: crypto.randomUUID(),
        userId: id,
        deltaUsdMicros: micros,
        kind: 'adjustment',
        ref: `adjustment:${crypto.randomUUID()}`,
        note: note ?? 'Manual adjustment by admin',
        createdAt: Date.now(),
      }),
      db
        .update(users)
        .set({ balanceUsdMicros: sql`${users.balanceUsdMicros} + ${micros}`, updatedAt: Date.now() })
        .where(eq(users.id, id)),
    ]);
  }

  const [updated] = await db.select().from(users).where(eq(users.id, id));
  const [kc] = await db.select({ n: count(apiKeys.id) }).from(apiKeys).where(eq(apiKeys.userId, id));
  return c.json(userDto(updated, kc?.n ?? 0));
});

adminApp.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!existing) return c.json(apiErr('User not found'), 404);
  // Org succession (M9): a deleted owner hands their orgs to the
  // longest-tenured remaining member; an org with nobody left to inherit dies
  // with its keys and ledger. Memberships of the deleted user always go.
  const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, id));
  for (const m of memberships) {
    if (m.role !== 'owner') continue;
    const successors = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, m.orgId), ne(orgMembers.userId, id)))
      .orderBy(asc(orgMembers.createdAt));
    if (successors.length > 0) {
      if (successors[0].role !== 'owner') {
        await db.update(orgMembers).set({ role: 'owner' }).where(eq(orgMembers.id, successors[0].id));
      }
    } else {
      await db.batch([
        db.delete(orgMembers).where(eq(orgMembers.orgId, m.orgId)),
        db.delete(apiKeys).where(eq(apiKeys.orgId, m.orgId)),
        db.delete(balanceEntries).where(eq(balanceEntries.orgId, m.orgId)),
        db.delete(orgs).where(eq(orgs.id, m.orgId)),
      ]);
    }
  }
  if (memberships.length > 0) {
    await db.delete(orgMembers).where(eq(orgMembers.userId, id));
  }
  // Keys, sessions and ledger entries go with the account; request_logs and
  // webhook_events survive for the historical/audit record (key attribution
  // degrades to a dangling id, same as deleted admin keys).
  await db.batch([
    db.delete(apiKeys).where(eq(apiKeys.userId, id)),
    db.delete(userSessions).where(eq(userSessions.userId, id)),
    db.delete(balanceEntries).where(eq(balanceEntries.userId, id)),
    db.delete(users).where(eq(users.id, id)),
  ]);
  return c.json({ ok: true });
});

// -------------------------------------------------------------------- orgs
// Organizations / teams (M9). Platform admin stays GLOBAL: admins see and
// manage every org without being members — list, rename, enable/disable,
// ledgered balance adjustments, delete (members, org keys and org ledger die
// with the org; request_logs keep org_id as the audit trail).

function orgAdminDto(r: typeof orgs.$inferSelect, memberCount = 0, keyCount = 0) {
  return {
    id: r.id,
    name: r.name,
    join_code: r.joinCode, // admin is global — sees invite codes too
    balance_usd: r.balanceUsdMicros / 1e6,
    enabled: Boolean(r.enabled),
    member_count: memberCount,
    key_count: keyCount,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

adminApp.get('/orgs', async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(orgs).orderBy(desc(orgs.createdAt));
  const memberCounts = await db.select({ orgId: orgMembers.orgId, n: count() }).from(orgMembers).groupBy(orgMembers.orgId);
  const keyCounts = await db.select({ orgId: apiKeys.orgId, n: count() }).from(apiKeys).groupBy(apiKeys.orgId);
  const membersBy = new Map(memberCounts.map((r) => [r.orgId, r.n]));
  const keysBy = new Map(keyCounts.filter((r) => r.orgId != null).map((r) => [r.orgId as string, r.n]));
  return c.json(rows.map((r) => orgAdminDto(r, membersBy.get(r.id) ?? 0, keysBy.get(r.id) ?? 0)));
});

adminApp.patch('/orgs/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const db = getDb(c.env);
  const [existing] = await db.select().from(orgs).where(eq(orgs.id, id));
  if (!existing) return c.json(apiErr('Organization not found'), 404);

  const patch: Partial<typeof orgs.$inferInsert> = { updatedAt: Date.now() };
  let touched = false;
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);
    patch.name = name;
    touched = true;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    patch.enabled = body.enabled;
    touched = true;
  }
  if (touched) {
    await db.update(orgs).set(patch).where(eq(orgs.id, id));
  }

  if (body.balance_adjust_usd !== undefined) {
    const adj = body.balance_adjust_usd;
    if (typeof adj !== 'number' || !Number.isFinite(adj) || adj === 0 || Math.abs(adj) > 1_000_000) {
      return c.json(apiErr('balance_adjust_usd must be a non-zero number within ±1,000,000'), 400);
    }
    const micros = Math.round(adj * 1e6);
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null;
    await db.batch([
      db.insert(balanceEntries).values({
        id: crypto.randomUUID(),
        orgId: id,
        deltaUsdMicros: micros,
        kind: 'adjustment',
        ref: `adjustment:${crypto.randomUUID()}`,
        note: note ?? 'Manual adjustment by admin',
        createdAt: Date.now(),
      }),
      db
        .update(orgs)
        .set({ balanceUsdMicros: sql`${orgs.balanceUsdMicros} + ${micros}`, updatedAt: Date.now() })
        .where(eq(orgs.id, id)),
    ]);
  }

  const [updated] = await db.select().from(orgs).where(eq(orgs.id, id));
  const [mc] = await db.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, id));
  const [kc] = await db.select({ n: count() }).from(apiKeys).where(eq(apiKeys.orgId, id));
  return c.json(orgAdminDto(updated, mc?.n ?? 0, kc?.n ?? 0));
});

adminApp.delete('/orgs/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const [existing] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, id));
  if (!existing) return c.json(apiErr('Organization not found'), 404);
  await db.batch([
    db.delete(orgMembers).where(eq(orgMembers.orgId, id)),
    db.delete(apiKeys).where(eq(apiKeys.orgId, id)),
    db.delete(balanceEntries).where(eq(balanceEntries.orgId, id)),
    db.delete(orgs).where(eq(orgs.id, id)),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------- billing config
// Lemon Squeezy merchant-of-record settings (M8). Secrets are stored
// AES-256-GCM encrypted; the API only ever exposes hints.

adminApp.get('/billing/config', async (c) => {
  return c.json(await billingConfigStatus(c.env));
});

adminApp.patch('/billing/config', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const patch: { storeId?: string | null; variantId?: string | null; apiKey?: string | null; webhookSecret?: string | null } = {};
  for (const field of ['store_id', 'variant_id'] as const) {
    if (body[field] !== undefined) {
      if (body[field] === null) patch[field === 'store_id' ? 'storeId' : 'variantId'] = null;
      else if (typeof body[field] === 'string') patch[field === 'store_id' ? 'storeId' : 'variantId'] = (body[field] as string).trim() || null;
      else return c.json(apiErr(`${field} must be a string or null`), 400);
    }
  }
  for (const field of ['api_key', 'webhook_secret'] as const) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === '') patch[field === 'api_key' ? 'apiKey' : 'webhookSecret'] = null;
      else if (typeof body[field] === 'string') {
        if ((body[field] as string).length > 4096) return c.json(apiErr(`${field} too long`), 400);
        patch[field === 'api_key' ? 'apiKey' : 'webhookSecret'] = body[field] as string;
      } else return c.json(apiErr(`${field} must be a string or null`), 400);
    }
  }
  await saveBillingConfig(c.env, patch);
  return c.json(await billingConfigStatus(c.env));
});

// ------------------------------------------------------------------ logs

type LogRow = typeof requestLogs.$inferSelect;

function logDto(r: LogRow, keyName: string | null, providerName: string | null, userEmail: string | null, orgName: string | null) {
  return {
    id: r.id,
    api_key_id: r.apiKeyId,
    key_name: keyName,
    user_id: r.userId,
    user_email: userEmail,
    org_id: r.orgId,
    org_name: orgName,
    model_slug: r.modelSlug,
    provider_id: r.providerId,
    provider_name: providerName,
    upstream_model: r.upstreamModel,
    dialect: r.dialect,
    status: r.status,
    latency_ms: r.latencyMs,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    cost_usd: r.costUsd,
    cache_hit: Boolean(r.cacheHit),
    error: r.error,
    created_at: r.createdAt,
  };
}

adminApp.get('/logs', async (c) => {
  const limit = Math.min(500, Math.max(1, Math.round(Number(c.req.query('limit')) || 100)));
  const offset = Math.max(0, Math.round(Number(c.req.query('offset')) || 0));

  const conditions = [];
  const keyId = c.req.query('api_key_id');
  if (keyId) conditions.push(eq(requestLogs.apiKeyId, keyId));
  const model = c.req.query('model');
  if (model) conditions.push(eq(requestLogs.modelSlug, model));
  const dialect = c.req.query('dialect');
  if (dialect === 'chat' || dialect === 'responses' || dialect === 'messages') conditions.push(eq(requestLogs.dialect, dialect));
  const status = c.req.query('status');
  if (status === '2xx') conditions.push(and(gte(requestLogs.status, 200), lt(requestLogs.status, 300)));
  else if (status === '4xx') conditions.push(and(gte(requestLogs.status, 400), lt(requestLogs.status, 500)));
  else if (status === '5xx') conditions.push(gte(requestLogs.status, 500));

  const rows = await getDb(c.env)
    .select({ log: requestLogs, keyName: apiKeys.name, providerName: providers.name, userEmail: users.email, orgName: orgs.name })
    .from(requestLogs)
    .leftJoin(apiKeys, eq(requestLogs.apiKeyId, apiKeys.id))
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .leftJoin(users, eq(requestLogs.userId, users.id))
    .leftJoin(orgs, eq(requestLogs.orgId, orgs.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json(rows.map((r) => logDto(r.log, r.keyName, r.providerName, r.userEmail ?? null, r.orgName ?? null)));
});

adminApp.delete('/logs', async (c) => {
  await getDb(c.env).delete(requestLogs);
  return c.json({ ok: true });
});
