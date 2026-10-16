import { eq, lt } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env';
import { b64urlEncode, b64urlDecode, hmacSign, hmacVerify, sha256Hex, safeEqualStr } from './crypto';
import { getDb } from './db';
import { apiKeys, sessions, userSessions, users } from './db/schema';

export const SESSION_COOKIE = 'khateway_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const te = new TextEncoder();
const td = new TextDecoder();

function sessionSecret(env: Env): string {
  return env.SESSION_SECRET || `${env.ENCRYPTION_KEY}::session`;
}

export function isSecureRequest(c: { req: { header: (k: string) => string | undefined; url: string } }): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Creates a signed session token (stateless part) and persists the SHA-256 of
 * the full token in the `sessions` table so sign-out can revoke it server-side.
 */
export async function createSessionToken(env: Env): Promise<string> {
  const payload = b64urlEncode(
    te.encode(JSON.stringify({ u: 'admin', exp: Date.now() + SESSION_TTL_MS })),
  );
  const sig = await hmacSign(sessionSecret(env), payload);
  const token = `${payload}.${sig}`;

  const now = Date.now();
  const db = getDb(env);
  await db.insert(sessions).values({ id: await sha256Hex(token), createdAt: now, expiresAt: now + SESSION_TTL_MS });
  await db.delete(sessions).where(lt(sessions.expiresAt, now)); // opportunistic purge
  return token;
}

/** The `sessions` row id for a signed session token (sha256 of the token) —
 * used to scope session-derived rows (e.g. M14 playground keys) and revoke
 * them together with the session. Null when no token is present. */
export async function sessionIdForToken(token: string | undefined): Promise<string | null> {
  return token ? sha256Hex(token) : null;
}

export async function sessionValid(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await hmacVerify(sessionSecret(env), payload, sig))) return false;

  let data: { u?: string; exp?: number };
  try {
    data = JSON.parse(td.decode(b64urlDecode(payload))) as { u?: string; exp?: number };
  } catch {
    return false;
  }
  if (!(data.u === 'admin' && typeof data.exp === 'number' && data.exp > Date.now())) return false;

  // Valid signature+expiry is not enough — the session row must still exist
  // (logout deletes it; revoked/expired tokens are rejected).
  const [row] = await getDb(env)
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, await sha256Hex(token)));
  return !!row;
}

export async function revokeSession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb(env).delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}

export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!(await sessionValid(c.env, token))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

// --- portal user sessions (M8) ----------------------------------------------
//
// Same revocable pattern as admin sessions — HMAC-signed cookie + DB row —
// but scoped to a portal user (`u: "user:<id>"`) in a separate table so admin
// and user sessions never mix and logout/admin-revoke work per user.

export const USER_SESSION_COOKIE = 'khateway_user';
export const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const USER_SESSION_TTL_MS = USER_SESSION_TTL_SECONDS * 1000;

/** Creates a signed user session token and persists its hash for revocation. */
export async function createUserSessionToken(env: Env, userId: string): Promise<string> {
  const payload = b64urlEncode(
    te.encode(JSON.stringify({ u: `user:${userId}`, exp: Date.now() + USER_SESSION_TTL_MS })),
  );
  const sig = await hmacSign(sessionSecret(env), payload);
  const token = `${payload}.${sig}`;

  const now = Date.now();
  const db = getDb(env);
  await db.insert(userSessions).values({ id: await sha256Hex(token), userId, createdAt: now, expiresAt: now + USER_SESSION_TTL_MS });
  await db.delete(userSessions).where(lt(userSessions.expiresAt, now)); // opportunistic purge
  return token;
}

/** Returns the user id for a valid, unexpired, non-revoked user token; else null. */
export async function userSessionUserId(env: Env, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await hmacVerify(sessionSecret(env), payload, sig))) return null;

  let data: { u?: string; exp?: number };
  try {
    data = JSON.parse(td.decode(b64urlDecode(payload))) as { u?: string; exp?: number };
  } catch {
    return null;
  }
  if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
  if (!data.u?.startsWith('user:')) return null;
  const userId = data.u.slice('user:'.length);
  if (!userId) return null;

  const [row] = await getDb(env)
    .select({ userId: userSessions.userId })
    .from(userSessions)
    .where(eq(userSessions.id, await sha256Hex(token)));
  return row?.userId === userId ? userId : null;
}

export async function revokeUserSession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb(env).delete(userSessions).where(eq(userSessions.id, await sha256Hex(token)));
}

/** Kills every session of a user (admin disable / password reset). */
export async function revokeAllUserSessions(env: Env, userId: string): Promise<void> {
  await getDb(env).delete(userSessions).where(eq(userSessions.userId, userId));
}

/**
 * Portal auth middleware — resolves the `khateway_user` cookie to a live user
 * and stores the userId (and the fresh row) in context. Disabled users are
 * rejected even with a valid session.
 */
export const portalAuth = createMiddleware<{ Bindings: Env; Variables: { userId: string; user: typeof users.$inferSelect } }>(
  async (c, next) => {
    const userId = await userSessionUserId(c.env, getCookie(c, USER_SESSION_COOKIE));
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const [user] = await getDb(c.env).select().from(users).where(eq(users.id, userId));
    if (!user || !user.enabled) return c.json({ error: 'Unauthorized' }, 401);
    c.set('userId', userId);
    c.set('user', user);
    await next();
  },
);

// --- client API keys (gateway auth, M7) ------------------------------------
//
// Raw keys look like `khat-<32 hex>` and are shown exactly once at creation;
// only sha256(raw) is stored (key_hash, unique). key_prefix (`khat-xxxx`) is
// kept unhashed solely for the admin UI. Verification is a hash lookup — no
// timing-sensitive comparison on the raw material is needed.

const KEY_ALPHABET = '0123456789abcdef';

/** Generates a new client key: `khat-<32hex>` + its 9-char prefix + sha256 hash. */
export async function generateClientKey(): Promise<{ raw: string; prefix: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let body = '';
  for (const b of bytes) body += KEY_ALPHABET[b >> 4] + KEY_ALPHABET[b & 15];
  const raw = `khat-${body}`;
  return { raw, prefix: raw.slice(0, 9), hash: await sha256Hex(raw) };
}

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Looks up an `Authorization: Bearer <key>` credential; null when unknown. */
export async function verifyClientKey(env: Env, rawKey: string | undefined): Promise<ApiKeyRow | null> {
  if (!rawKey) return null;
  const [row] = await getDb(env).select().from(apiKeys).where(eq(apiKeys.keyHash, await sha256Hex(rawKey)));
  return row ?? null;
}

// --- credentials -----------------------------------------------------------

export function timingSafeStrEqual(a: string, b: string): boolean {
  return safeEqualStr(a, b);
}

// --- login rate limiting ---
// P2: the per-isolate memory map moved to the RateLimiterDO (cross-isolate) —
// loginAllowed now lives in ratelimit/client.ts and takes env. Bucketing is
// unchanged: per surface + IP in fixed 1-minute windows.
