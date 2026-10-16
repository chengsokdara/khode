// /api/v1/device — RFC 8628-shaped device authorization for CLI/TUI clients
// (khode). Three actors: the CLIENT mints a request (no auth — a pending
// request grants nothing) and polls the token endpoint; a HUMAN approves or
// denies it in the portal (/app/device, routes/portal.ts — the session cookie
// is the only authority there). The grant is a PERSONAL client API key for
// the approving account: an ordinary portal key (visible + revocable at
// /app), balance-gated and attributed like any key. device_code is stored
// hashed (client-key philosophy); the grant is ONE-SHOT (approved →
// consumed) — a client that misses the response simply re-runs the flow.
//
// These endpoints deliberately do NOT require a client key (the client has
// none yet — that is the point) and do NOT ride the keyless gate (they mint
// keys; the gate governs keyless /v1 usage). Abuse is bounded by the per-IP
// in-memory buckets below: a minted code nobody approves is worthless.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, lt } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { apiKeys, deviceCodes, users } from '../db/schema';
import { generateClientKey } from '../auth';
import { loginAllowed } from '../ratelimit/client';
import { sha256Hex } from '../crypto';

type DeviceEnv = { Bindings: Env };

export const deviceApp = new Hono<DeviceEnv>();

const DEVICE_TTL_MS = 10 * 60_000;
const DEVICE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;

/** Unambiguous alphabet for the human-typed code (no 0/O/1/I/L). */
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const apiErr = (error: string) => ({ error });

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** XXXX-XXXX from the unambiguous alphabet (mod-34 bias is irrelevant for a
 * human-typed, rate-limited UX code — this is not the secret). */
function generateUserCode(): string {
  const one = new Uint8Array(8);
  crypto.getRandomValues(one);
  const raw = Array.from(one, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Mints a device sign-in request. The verification URL points the user at
 * the portal approve page (SPA route /app/device), pre-filled via
 * verification_uri_complete.
 */
deviceApp.post('/code', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!(await loginAllowed(c.env, 'device-code', ip, 10))) return c.json(apiErr('Too many device sign-in requests — try again in a minute.'), 429);
  const body = await readJson(c);
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim().slice(0, 120) || null : null;

  // Opportunistic sweep of expired rows (indexed) — the table stays small.
  try {
    await getDb(c.env).delete(deviceCodes).where(lt(deviceCodes.expiresAt, Date.now()));
  } catch {
    // sweep failure must never block minting
  }

  const deviceCode = randomHex(32);
  const now = Date.now();
  const record = {
    id: crypto.randomUUID(),
    deviceCodeHash: await sha256Hex(deviceCode),
    displayName,
    status: 'pending' as const,
    createdAt: now,
    expiresAt: now + DEVICE_TTL_MS,
  };
  // The unique user_code index is the backstop; the loop keeps the happy
  // path collision-free (~1.1e12 codes — retries never fire in practice).
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await getDb(c.env).insert(deviceCodes).values({ ...record, userCode });
    } catch {
      continue; // user_code collision — regenerate
    }
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${origin}/app/device`,
        verification_uri_complete: `${origin}/app/device?code=${userCode}`,
        expires_in: DEVICE_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      },
      201,
    );
  }
  return c.json(apiErr('Could not allocate a device code — try again.'), 500);
});

function tokenErr(c: Context<DeviceEnv>, error: string, error_description: string, status: 400 | 429 = 400) {
  return c.json({ error, error_description }, status);
}

/**
 * The poll endpoint. RFC 8628 error vocabulary on the failure paths
 * (authorization_pending / access_denied / expired_token); success returns
 * the issued key ONCE and consumes the request.
 */
deviceApp.post('/token', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!(await loginAllowed(c.env, 'device-token', ip, 60))) return tokenErr(c, 'slow_down', 'Polling too fast — slow down.', 429);
  const body = await readJson(c);
  const deviceCode = typeof body?.device_code === 'string' ? body.device_code.trim() : '';
  if (!deviceCode) return tokenErr(c, 'expired_token', 'device_code is required.');

  const [row] = await getDb(c.env)
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCodeHash, await sha256Hex(deviceCode)));
  if (!row || row.expiresAt < Date.now() || row.status === 'consumed') {
    return tokenErr(c, 'expired_token', 'Unknown, expired or already-used device code — start the sign-in flow again.');
  }
  if (row.status === 'denied') return tokenErr(c, 'access_denied', 'The user denied the sign-in request.');
  if (row.status !== 'approved' || !row.userId) {
    return tokenErr(c, 'authorization_pending', 'Open the verification URL in a browser and approve the request.');
  }

  // Consume FIRST with a status guard (one-shot grant — a racing poll loses
  // here and gets expired_token, never a second key), then mint the key. If
  // the mint itself fails the client re-runs the flow (10 seconds of UX).
  const { raw, prefix, hash } = await generateClientKey();
  const keyId = crypto.randomUUID();
  const consumed = await getDb(c.env)
    .update(deviceCodes)
    .set({ status: 'consumed', keyId })
    .where(and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, 'approved')))
    .returning({ id: deviceCodes.id });
  if (consumed.length === 0) return tokenErr(c, 'expired_token', 'This device code was already used.');

  const key = {
    id: keyId,
    name: row.displayName ?? 'khode',
    keyHash: hash,
    keyPrefix: prefix,
    userId: row.userId,
    spendLimitUsd: null, // the prepaid balance governs user keys
    allowedModels: null,
    enabled: true,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await getDb(c.env).insert(apiKeys).values(key);
  const [user] = await getDb(c.env)
    .select({ email: users.email, balance: users.balanceUsdMicros })
    .from(users)
    .where(eq(users.id, row.userId));
  return c.json({
    access_token: raw,
    token_type: 'bearer',
    key: { id: key.id, name: key.name, key_prefix: prefix },
    user: { email: user?.email ?? null, balance_usd: user ? user.balance / 1e6 : 0 },
  });
});
