// /api/portal — public portal API for Khateway user accounts (M8).
//
// AUTH:  POST /signup | /login | /logout are anonymous (session cookie IS the
// result); GET /me and everything below require the `khateway_user` session.
// KEYS:  users manage ONLY their own `khat-` keys (api_keys.user_id). They set
// no spend limits — the prepaid balance governs; admin keys (user_id null)
// are invisible here.
// USAGE: recent request logs across the user's keys.
// BILLING: balance + ledger entries, and hosted Lemon Squeezy checkout URLs
// for top-ups (the webhook credit is handled in routes/webhooks.ts).
import { Hono } from 'hono';
import type { Context } from 'hono';
import { count, desc, eq, gt, inArray, isNull, and, sum } from 'drizzle-orm';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env';
import { getDb } from '../db';
import { apiKeys, balanceEntries, deviceCodes, requestLogs, users } from '../db/schema';
import { getPublicSignup } from '../db/settings';
import { billingConfigured, billingConfigStatus, getBillingConfig } from '../billing/config';
import { createLsCheckout } from '../billing/lemonsqueezy';
import { hashPassword, verifyPassword } from '../crypto';
import {
  USER_SESSION_COOKIE,
  USER_SESSION_TTL_SECONDS,
  createUserSessionToken,
  generateClientKey,
  isSecureRequest,
  portalAuth,
  revokeUserSession,
} from '../auth';
import { loginAllowed } from '../ratelimit/client';

type UserRow = typeof users.$inferSelect;
type PortalEnv = { Bindings: Env; Variables: { userId: string; user: UserRow } };

export const portalApp = new Hono<PortalEnv>();

const apiErr = (error: string) => ({ error });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Top-up bounds in USD (Lemon Squeezy custom price, cent-denominated). */
const TOPUP_MIN_USD = 1;
const TOPUP_MAX_USD = 500;

function userDto(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    balance_usd: u.balanceUsdMicros / 1e6,
    enabled: Boolean(u.enabled),
    created_at: u.createdAt,
  };
}

function setSessionCookie(c: Context<PortalEnv>, token: string) {
  setCookie(c, USER_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: USER_SESSION_TTL_SECONDS,
    secure: isSecureRequest(c),
  });
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseAllowedModels(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

function apiKeyDto(r: { id: string; name: string; keyPrefix: string; allowedModels: string | null; rateLimitRpm?: number | null; cacheEnabled?: boolean | number; enabled: boolean | number; lastUsedAt: number | null; createdAt: number }, spentUsd: number, requestCount: number) {
  return {
    id: r.id,
    name: r.name,
    key_prefix: r.keyPrefix,
    allowed_models: parseAllowedModels(r.allowedModels),
    // M10: admins set per-key rate limits; portal accounts see them read-only
    // (the prepaid balance governs usage, limits are not user-configurable).
    rate_limit_rpm: r.rateLimitRpm ?? null,
    // M11: semantic-cache opt-in is an admin/model-level switch; read-only here.
    cache_enabled: Boolean(r.cacheEnabled),
    enabled: Boolean(r.enabled),
    last_used_at: r.lastUsedAt ?? null,
    created_at: r.createdAt,
    spent_usd: spentUsd,
    request_count: requestCount,
  };
}

/** Per-key usage aggregates — SQL SUM (M15: was an unbounded row load). */
async function keyUsage(db: ReturnType<typeof getDb>, id: string): Promise<{ spentUsd: number; requests: number }> {
  const [agg] = await db
    .select({ spent: sum(requestLogs.costUsd), requests: count() })
    .from(requestLogs)
    .where(eq(requestLogs.apiKeyId, id));
  return { spentUsd: agg?.spent != null ? Number(agg.spent) : 0, requests: agg?.requests ?? 0 };
}

// ------------------------------------------------------------------ session
// Public: the rate limiter is the in-memory per-isolate one shared with admin
// login (10/min/IP) — brute force gets the same hard time.

portalApp.post('/signup', async (c) => {
  const body = await readJson(c);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return c.json(apiErr('Enter a valid email address'), 400);
  if (password.length < 8) return c.json(apiErr('Password must be at least 8 characters'), 400);
  if (password.length > 200) return c.json(apiErr('Password must be at most 200 characters'), 400);
  // Only validated signup attempts consume the budget — validation failures
  // reveal nothing and would let a noisy smoke run lock the bucket.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!(await loginAllowed(c.env, 'portal-signup', ip, 20))) return c.json(apiErr('Too many attempts — try again in a minute.'), 429);
  if ((await getPublicSignup(c.env)) === 'off') {
    return c.json(apiErr('Public signups are currently disabled on this Khateway instance.'), 403);
  }

  const now = Date.now();
  const rec = {
    id: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword(password),
    balanceUsdMicros: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  // onConflictDoNothing + re-select by OUR id: deterministic 409 without
  // parsing D1 error text (drizzle wraps constraint violations as "Failed
  // query"). If our id didn't land, the email was already taken.
  await getDb(c.env).insert(users).values(rec).onConflictDoNothing();
  const [created] = await getDb(c.env).select({ id: users.id }).from(users).where(eq(users.id, rec.id));
  if (!created) return c.json(apiErr('An account with this email already exists'), 409);
  const token = await createUserSessionToken(c.env, rec.id);
  setSessionCookie(c, token);
  return c.json({ user: userDto({ ...rec, enabled: true }) }, 201);
});

portalApp.post('/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!(await loginAllowed(c.env, 'portal-login', ip))) return c.json(apiErr('Too many attempts — try again in a minute.'), 429);
  const body = await readJson(c);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const [user] = email ? await getDb(c.env).select().from(users).where(eq(users.email, email)) : [];
  const storedHash = user?.passwordHash ?? null;
  // OAuth-only account (social sign-in, no password ever set): tell the user
  // which door to use — this is the one case that names the method, because
  // the email itself proves the account exists.
  if (user && !storedHash) {
    return c.json(apiErr('This account signs in with Google/GitHub — use the buttons above.'), 401);
  }
  // Same message for unknown email / wrong password / disabled account — no
  // account-existence oracle.
  if (!user || !storedHash || !(await verifyPassword(password, storedHash)) || !user.enabled) {
    return c.json(apiErr('Invalid email or password'), 401);
  }
  const token = await createUserSessionToken(c.env, user.id);
  setSessionCookie(c, token);
  return c.json({ user: userDto(user) });
});

portalApp.post('/logout', async (c) => {
  await revokeUserSession(c.env, getCookie(c, USER_SESSION_COOKIE)); // server-side revocation
  deleteCookie(c, USER_SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Everything below requires a live portal session.
portalApp.use('*', portalAuth);

// ---------------------------------------------------------------------- me

portalApp.get('/me', async (c) => {
  const billing = await billingConfigStatus(c.env);
  return c.json({ user: userDto(c.get('user')), billing_configured: billing.configured });
});

// -------------------------------------------------------------------- keys

portalApp.get('/keys', async (c) => {
  const db = getDb(c.env);
  // Personal keys only — org-scoped keys (M9) live under /api/portal/orgs.
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, c.get('userId')), isNull(apiKeys.orgId)))
    .orderBy(desc(apiKeys.createdAt));
  const out = [];
  for (const r of rows) {
    const usage = await keyUsage(db, r.id);
    out.push(apiKeyDto(r, usage.spentUsd, usage.requests));
  }
  return c.json(out);
});

portalApp.post('/keys', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);

  let allowedModels: string[] | null = null;
  if (body.allowed_models !== undefined && body.allowed_models !== null) {
    if (!Array.isArray(body.allowed_models) || body.allowed_models.length > 100 || !body.allowed_models.every((x) => typeof x === 'string' && x.trim())) {
      return c.json(apiErr('allowed_models must be an array of model slugs (max 100)'), 400);
    }
    allowedModels = (body.allowed_models as string[]).map((x) => x.trim());
  }

  const { raw, prefix, hash } = await generateClientKey();
  const rec = {
    id: crypto.randomUUID(),
    name,
    keyHash: hash,
    keyPrefix: prefix,
    userId: c.get('userId'),
    spendLimitUsd: null, // balance governs user keys; no self-service spend caps
    allowedModels: allowedModels ? JSON.stringify(allowedModels) : null,
    enabled: true,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await getDb(c.env).insert(apiKeys).values(rec);
  // The raw key rides ONLY in this response — never stored, never logged.
  return c.json({ ...apiKeyDto(rec, 0, 0), key: raw }, 201);
});

/** Owns-the-key guard: personal keys only (org keys route through /orgs),
 * 404 (not 403) to avoid existence leaks. */
async function ownKey(env: Env, userId: string, id: string): Promise<typeof apiKeys.$inferSelect | null> {
  const [row] = await getDb(env)
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.orgId)));
  return row ?? null;
}

portalApp.patch('/keys/:id', async (c) => {
  const existing = await ownKey(c.env, c.get('userId'), c.req.param('id'));
  if (!existing) return c.json(apiErr('API key not found'), 404);
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);

  const patch: Partial<typeof apiKeys.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return c.json(apiErr('Name must be 1–120 characters'), 400);
    patch.name = name;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json(apiErr('enabled must be a boolean'), 400);
    patch.enabled = body.enabled;
  }
  if (body.allowed_models !== undefined) {
    if (body.allowed_models === null) patch.allowedModels = null;
    else if (Array.isArray(body.allowed_models) && body.allowed_models.length <= 100 && body.allowed_models.every((x) => typeof x === 'string' && x.trim())) {
      patch.allowedModels = JSON.stringify((body.allowed_models as string[]).map((x) => x.trim()));
    } else return c.json(apiErr('allowed_models must be null or an array of model slugs (max 100)'), 400);
  }

  if (Object.keys(patch).length > 0) {
    await getDb(c.env).update(apiKeys).set(patch).where(eq(apiKeys.id, existing.id));
  }
  const [updated] = await getDb(c.env).select().from(apiKeys).where(eq(apiKeys.id, existing.id));
  const usage = await keyUsage(getDb(c.env), existing.id);
  return c.json(apiKeyDto(updated, usage.spentUsd, usage.requests));
});

portalApp.delete('/keys/:id', async (c) => {
  const existing = await ownKey(c.env, c.get('userId'), c.req.param('id'));
  if (!existing) return c.json(apiErr('API key not found'), 404);
  await getDb(c.env).delete(apiKeys).where(eq(apiKeys.id, existing.id));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- usage

portalApp.get('/usage', async (c) => {
  const limit = Math.min(200, Math.max(1, Math.round(Number(c.req.query('limit')) || 50)));
  const db = getDb(c.env);
  // Personal surface: keys I own with no org scope (M9) — org usage lives on the org.
  const keys = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, c.get('userId')), isNull(apiKeys.orgId)));
  if (keys.length === 0) return c.json([]);
  const rows = await db
    .select()
    .from(requestLogs)
    .where(inArray(requestLogs.apiKeyId, keys.map((k) => k.id)))
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      model_slug: r.modelSlug,
      dialect: r.dialect,
      status: r.status,
      latency_ms: r.latencyMs,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      cost_usd: r.costUsd,
      created_at: r.createdAt,
    })),
  );
});

// ----------------------------------------------------------------- billing

portalApp.get('/billing', async (c) => {
  const db = getDb(c.env);
  const [entries, billing] = await Promise.all([
    db.select().from(balanceEntries).where(eq(balanceEntries.userId, c.get('userId'))).orderBy(desc(balanceEntries.createdAt)).limit(100),
    billingConfigStatus(c.env),
  ]);
  return c.json({
    balance_usd: c.get('user').balanceUsdMicros / 1e6,
    configured: billing.configured,
    entries: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      delta_usd: e.deltaUsdMicros / 1e6,
      note: e.note,
      created_at: e.createdAt,
    })),
  });
});

portalApp.post('/billing/checkout', async (c) => {
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  const amount = typeof body.amount_usd === 'number' ? body.amount_usd : NaN;
  if (!Number.isFinite(amount)) return c.json(apiErr('amount_usd must be a number'), 400);
  const cents = Math.round(amount * 100);
  if (cents < TOPUP_MIN_USD * 100 || cents > TOPUP_MAX_USD * 100) {
    return c.json(apiErr(`amount_usd must be between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}`), 400);
  }

  const cfg = await getBillingConfig(c.env);
  if (!billingConfigured(cfg)) {
    return c.json(apiErr('Top-ups are not available yet — billing is not configured.'), 400);
  }
  const user = c.get('user');
  const origin = new URL(c.req.url).origin;
  const result = await createLsCheckout({
    storeId: cfg.storeId!,
    variantId: cfg.variantId!,
    apiKey: cfg.apiKey!,
    amountUsdCents: cents,
    userEmail: user.email,
    userId: user.id,
    redirectUrl: `${origin}/app?topup=success`,
  });
  if (!result.ok) return c.json(apiErr(result.error), 502);
  return c.json({ url: result.url });
});

// ----------------------------------------------------------------- device
// RFC 8628 user-approval surface for CLI/TUI sign-in (khode): the terminal
// shows a short code, the signed-in user confirms it here. The portal
// session is the authority — whoever approves binds the eventual key to
// THEIR account (portal.ts routes above this comment all ride portalAuth).

/** Lenient user-code entry: case/spaces/dashes-insensitive, format XXXX-XXXX. */
function normalizeUserCode(raw: string): string | null {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(stripped) ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : null;
}

portalApp.get('/device/:code', async (c) => {
  const code = normalizeUserCode(c.req.param('code'));
  if (!code) return c.json(apiErr('Invalid device code format'), 400);
  const [row] = await getDb(c.env)
    .select({ status: deviceCodes.status, displayName: deviceCodes.displayName, createdAt: deviceCodes.createdAt })
    .from(deviceCodes)
    .where(and(eq(deviceCodes.userCode, code), gt(deviceCodes.expiresAt, Date.now())));
  if (!row) return c.json(apiErr('No active device sign-in with this code — check the code, or restart sign-in in your terminal.'), 404);
  return c.json({ status: row.status, display_name: row.displayName, created_at: row.createdAt });
});

portalApp.post('/device/:code/approve', async (c) => {
  const code = normalizeUserCode(c.req.param('code'));
  if (!code) return c.json(apiErr('Invalid device code format'), 400);
  const body = await readJson(c);
  if (body?.action !== 'approve' && body?.action !== 'deny') {
    return c.json(apiErr("action must be 'approve' or 'deny'"), 400);
  }
  const now = Date.now();
  const [row] = await getDb(c.env)
    .select({ id: deviceCodes.id })
    .from(deviceCodes)
    .where(and(eq(deviceCodes.userCode, code), eq(deviceCodes.status, 'pending'), gt(deviceCodes.expiresAt, now)));
  if (!row) return c.json(apiErr('No pending device sign-in with this code — it may have expired; restart sign-in in your terminal.'), 404);
  const approve = body.action === 'approve';
  await getDb(c.env)
    .update(deviceCodes)
    .set({ status: approve ? 'approved' : 'denied', userId: approve ? c.get('userId') : null, approvedAt: now })
    .where(eq(deviceCodes.id, row.id));
  return c.json({ ok: true, status: approve ? 'approved' : 'denied' });
});
