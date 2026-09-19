// /api/v1 — client-facing key + credit management API (M16, OpenRouter
// parity): the programmatic surface tools call to check a key's spend limit,
// accrued usage and prepaid balance without logging into the portal. The
// HMAC-signed portal session does NOT work here — a client API key IS the
// credential (Bearer or x-api-key, same header rules as /v1). Unlike /v1
// under the keyless-native default, every endpoint here REQUIRES a valid
// enabled key: the answers describe that key, so anonymous calls have no
// meaning. Errors are OpenAI-envelope shaped (the openai client face).
import { Hono } from 'hono';
import { eq, sum, count } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { apiKeys, orgs, requestLogs, users } from '../db/schema';
import { loginAllowed, verifyClientKey, type ApiKeyRow } from '../auth';
import { openAiError } from '../dialects/openaiChat';

type ClientApiEnv = { Bindings: Env; Variables: { clientKey: ApiKeyRow } };

export const clientApiApp = new Hono<ClientApiEnv>();

function error401(message: string): Response {
  return new Response(JSON.stringify(openAiError(401, message, { code: 'invalid_api_key', type: 'authentication_error' })), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function errorJson(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify(openAiError(status, message, { code })), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// A client API key is required for every answer here. The in-memory bucket
// (login-limiter pattern, per-isolate like admin/portal-login) bounds
// brute-force probing of the key space; the gateway DO migration stays queued.
clientApiApp.use('*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!loginAllowed('client-api', ip, 60)) {
    return errorJson(429, 'Too many requests — try again in a minute.', 'rate_limit_exceeded');
  }
  const bearer = c.req.header('authorization') ?? '';
  const raw = (bearer.startsWith('Bearer ') ? bearer.slice(7) : '').trim() || (c.req.header('x-api-key') ?? '').trim();
  const key = raw && raw !== 'anonymous' ? await verifyClientKey(c.env, raw) : null;
  if (!key || !key.enabled) return error401('Invalid or disabled API key — this endpoint requires a client API key.');
  c.set('clientKey', key);
  await next();
});

/** Accrued usage for ONE key (rides request_logs_api_key_idx). */
async function keyUsage(db: ReturnType<typeof getDb>, keyId: string): Promise<{ usage: number; requests: number }> {
  const [agg] = await db
    .select({ spent: sum(requestLogs.costUsd), requests: count() })
    .from(requestLogs)
    .where(eq(requestLogs.apiKeyId, keyId));
  return { usage: agg?.spent != null ? Number(agg.spent) : 0, requests: agg?.requests ?? 0 };
}

function keyDto(key: ApiKeyRow, usage: number) {
  return {
    object: 'key',
    label: key.name,
    limit: key.spendLimitUsd ?? null,
    usage,
    limit_remaining: key.spendLimitUsd == null ? null : Math.max(0, Math.round((key.spendLimitUsd - usage) * 1e6) / 1e6),
    is_disabled: !key.enabled,
    created_at: Math.floor(key.createdAt / 1000),
  };
}

// OpenRouter-compat aliases: /auth/key is the documented one, /key the
// convenience shorthand — same answer either way.
for (const path of ['/auth/key', '/key']) {
  clientApiApp.get(path, async (c) => {
    const key = c.get('clientKey');
    const db = getDb(c.env);
    const usage = await keyUsage(db, key.id);
    return c.json({ data: keyDto(key, usage.usage) });
  });
}

clientApiApp.get('/credits', async (c) => {
  const key = c.get('clientKey');
  const db = getDb(c.env);
  const usage = await keyUsage(db, key.id);

  // Personal keys draw the user's prepaid balance; org keys the org's shared
  // balance (M9). Admin-managed keys (user_id and org_id null) have no
  // balance attached — 404 instead of a fake zero.
  if (key.orgId) {
    const [org] = await db.select({ balance: orgs.balanceUsdMicros }).from(orgs).where(eq(orgs.id, key.orgId));
    if (!org) return errorJson(404, 'The organization owning this API key no longer exists.', 'not_found');
    const [orgAgg] = await db
      .select({ spent: sum(requestLogs.costUsd) })
      .from(requestLogs)
      .where(eq(requestLogs.orgId, key.orgId));
    return c.json({
      object: 'credit_balance',
      data: {
        total_credits: Math.round(org.balance) / 1e6,
        total_usage: orgAgg?.spent != null ? Math.round(Number(orgAgg.spent) * 1e6) / 1e6 : 0,
        scope: 'org',
        key_usage: usage.usage,
        key_requests: usage.requests,
      },
    });
  }
  if (key.userId) {
    const [user] = await db.select({ balance: users.balanceUsdMicros }).from(users).where(eq(users.id, key.userId));
    if (!user) return errorJson(404, 'The account owning this API key no longer exists.', 'not_found');
    const [userAgg] = await db
      .select({ spent: sum(requestLogs.costUsd) })
      .from(requestLogs)
      .where(eq(requestLogs.userId, key.userId));
    return c.json({
      object: 'credit_balance',
      data: {
        total_credits: Math.round(user.balance) / 1e6,
        total_usage: userAgg?.spent != null ? Math.round(Number(userAgg.spent) * 1e6) / 1e6 : 0,
        scope: 'user',
        key_usage: usage.usage,
        key_requests: usage.requests,
      },
    });
  }
  return errorJson(404, 'This API key has no prepaid balance attached — it is an admin-managed key.', 'no_balance');
});

clientApiApp.all('*', (c) => errorJson(404, `Unknown endpoint: '${c.req.method} ${c.req.path}'`, 'unknown_endpoint'));
