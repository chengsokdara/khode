// /api/portal/orgs — multi-user orgs / teams (M9).
//
// ROLES: 'owner' manages the org (rename, delete, members incl. role changes,
// every org key, billing/top-up); 'member' creates and manages their OWN org
// keys and views org usage + balance. Platform admin stays global (see
// routes/admin.ts — admins are not org members).
// INVITES: join codes — Workers has no email sender, so owners share a code
// and any portal user redeems it to join as a member. Codes are rotatable.
// BALANCE: org keys draw the ORG's shared prepaid balance (orgs.balance_usd_micros
// + balance_entries rows with org_id set); the gateway gates and debits it
// (routes/gateway.ts). request_logs.user_id = key creator, org_id = org.
import { Hono } from 'hono';
import { and, asc, count, desc, eq, sum } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { apiKeys, balanceEntries, orgMembers, orgs, requestLogs, users } from '../db/schema';
import { billingConfigured, billingConfigStatus, getBillingConfig } from '../billing/config';
import { createLsCheckout } from '../billing/lemonsqueezy';
import { generateClientKey, portalAuth } from '../auth';
import { loginAllowed } from '../ratelimit/client';

type UserRow = typeof users.$inferSelect;
type OrgRow = typeof orgs.$inferSelect;
type MemberRow = typeof orgMembers.$inferSelect;
type OrgEnv = { Bindings: Env; Variables: { userId: string; user: UserRow } };

export const orgApp = new Hono<OrgEnv>();

const apiErr = (error: string) => ({ error });

/** Top-up bounds in USD (same Lemon Squeezy custom-price bounds as personal). */
const TOPUP_MIN_USD = 1;
const TOPUP_MAX_USD = 500;
const ORG_NAME_MAX = 120;
/** Join codes: unambiguous alphabet, 10 chars (~50 bits) — collisions are
 * theoretical but the column is UNIQUE, so creation retries. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 10;

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

function generateJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Inserts a membership row; returns false when the (org, user) pair exists. */
async function addMember(env: Env, orgId: string, userId: string, role: string): Promise<boolean> {
  try {
    await getDb(env).insert(orgMembers).values({ id: crypto.randomUUID(), orgId, userId, role, createdAt: Date.now() });
    return true;
  } catch {
    return false; // unique (org_id, user_id) — drizzle wraps the constraint error
  }
}

/** Creates an org with a unique join code (retries on the theoretical
 * join_code collision). Caller owns the transaction shape — no batch needed. */
async function createOrgRow(env: Env, name: string): Promise<OrgRow> {
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const rec: OrgRow = {
      id: crypto.randomUUID(),
      name,
      joinCode: generateJoinCode(),
      balanceUsdMicros: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await getDb(env).insert(orgs).values(rec);
      return rec;
    } catch (e) {
      if (attempt === 2) throw e;
      // else: likely a join_code collision — regenerate and retry
    }
  }
  throw new Error('unreachable');
}

/** Resolves the caller's membership; null = unknown org OR not a member (both
 * answer 404 — no existence leak). */
async function membership(
  env: Env,
  orgId: string,
  userId: string,
): Promise<{ org: OrgRow; member: MemberRow } | null> {
  const db = getDb(env);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return null;
  const [member] = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  if (!member) return null;
  return { org, member };
}

async function ownerCount(db: ReturnType<typeof getDb>, orgId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
  return row?.n ?? 0;
}

function orgDto(o: OrgRow, role: string, extra: Record<string, unknown> = {}) {
  return {
    id: o.id,
    name: o.name,
    role,
    balance_usd: o.balanceUsdMicros / 1e6,
    enabled: Boolean(o.enabled),
    created_at: o.createdAt,
    ...extra,
  };
}

function memberDto(m: MemberRow, email: string | null) {
  return { user_id: m.userId, email, role: m.role, joined_at: m.createdAt };
}

function orgKeyDto(
  r: { id: string; name: string; keyPrefix: string; allowedModels: string | null; rateLimitRpm?: number | null; cacheEnabled?: boolean | number; enabled: boolean | number; lastUsedAt: number | null; createdAt: number; userId: string | null },
  spentUsd: number,
  requestCount: number,
  creatorEmail: string | null,
) {
  return {
    id: r.id,
    name: r.name,
    key_prefix: r.keyPrefix,
    allowed_models: parseAllowedModels(r.allowedModels),
    // M10: read-only for members — admins set per-key rate limits.
    rate_limit_rpm: r.rateLimitRpm ?? null,
    // M11: read-only — cache opt-in lives on the model/admin key surfaces.
    cache_enabled: Boolean(r.cacheEnabled),
    enabled: Boolean(r.enabled),
    last_used_at: r.lastUsedAt ?? null,
    created_at: r.createdAt,
    created_by: r.userId,
    created_by_email: creatorEmail,
    spent_usd: spentUsd,
    request_count: requestCount,
  };
}

/** Spent/request aggregates for every org key in one grouped query. */
async function orgKeyUsage(db: ReturnType<typeof getDb>, orgId: string): Promise<Map<string, { spentUsd: number; requests: number }>> {
  const rows = await db
    .select({ keyId: requestLogs.apiKeyId, spent: sum(requestLogs.costUsd), requests: count() })
    .from(requestLogs)
    .where(eq(requestLogs.orgId, orgId))
    .groupBy(requestLogs.apiKeyId);
  const map = new Map<string, { spentUsd: number; requests: number }>();
  for (const r of rows) {
    if (r.keyId) map.set(r.keyId, { spentUsd: r.spent != null ? Number(r.spent) : 0, requests: r.requests });
  }
  return map;
}

// Everything under /orgs requires a live portal session.
orgApp.use('*', portalAuth);

// ---------------------------------------------------------------------- list

orgApp.get('/orgs', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ org: orgs, member: orgMembers })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
    .where(eq(orgMembers.userId, c.get('userId')))
    .orderBy(asc(orgs.name));
  const counts = await db
    .select({ orgId: orgMembers.orgId, n: count() })
    .from(orgMembers)
    .groupBy(orgMembers.orgId);
  const countBy = new Map(counts.map((r) => [r.orgId, r.n]));
  return c.json(rows.map((r) => orgDto(r.org, r.member.role, { member_count: countBy.get(r.org.id) ?? 1 })));
});

orgApp.post('/orgs', async (c) => {
  const body = await readJson(c);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > ORG_NAME_MAX) return c.json(apiErr(`Name must be 1–${ORG_NAME_MAX} characters`), 400);
  const org = await createOrgRow(c.env, name);
  await addMember(c.env, org.id, c.get('userId'), 'owner');
  return c.json(orgDto(org, 'owner', { member_count: 1 }), 201);
});

orgApp.post('/orgs/join', async (c) => {
  const body = await readJson(c);
  const code = typeof body?.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!code) return c.json(apiErr('Enter a join code'), 400);
  // Guessable-secret surface: cap attempts per ACCOUNT (authenticated, so the
  // per-user key beats per-IP — users behind one NAT never starve each other).
  if (!(await loginAllowed(c.env, `org-join:${c.get('userId')}`, c.req.header('cf-connecting-ip') ?? 'local', 20))) {
    return c.json(apiErr('Too many attempts — try again in a minute.'), 429);
  }

  const db = getDb(c.env);
  const [org] = await db.select().from(orgs).where(eq(orgs.joinCode, code));
  if (!org || !org.enabled) return c.json(apiErr('Invalid join code'), 404);
  const created = await addMember(c.env, org.id, c.get('userId'), 'member');
  if (!created) return c.json(apiErr('You are already a member of this organization'), 409);
  return c.json(orgDto(org, 'member', { member_count: (await memberCount(db, org.id)) }), 201);
});

async function memberCount(db: ReturnType<typeof getDb>, orgId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  return row?.n ?? 0;
}

// ------------------------------------------------------------------- detail

orgApp.get('/orgs/:id', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const { org, member } = resolved;
  const db = getDb(c.env);
  const memberRows = await db
    .select({ member: orgMembers, email: users.email })
    .from(orgMembers)
    .leftJoin(users, eq(orgMembers.userId, users.id))
    .where(eq(orgMembers.orgId, org.id))
    .orderBy(asc(orgMembers.createdAt));
  return c.json({
    ...orgDto(org, member.role, { member_count: memberRows.length }),
    // The invite code is an owner-only secret.
    join_code: member.role === 'owner' ? org.joinCode : undefined,
    members: memberRows.map((r) => memberDto(r.member, r.email ?? null)),
  });
});

orgApp.patch('/orgs/:id', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can rename the organization'), 403);
  const body = await readJson(c);
  if (!body) return c.json(apiErr('Invalid JSON body'), 400);
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > ORG_NAME_MAX) return c.json(apiErr(`Name must be 1–${ORG_NAME_MAX} characters`), 400);
    await getDb(c.env).update(orgs).set({ name, updatedAt: Date.now() }).where(eq(orgs.id, resolved.org.id));
  }
  const [updated] = await getDb(c.env).select().from(orgs).where(eq(orgs.id, resolved.org.id));
  return c.json(orgDto(updated, resolved.member.role));
});

orgApp.delete('/orgs/:id', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can delete the organization'), 403);
  const db = getDb(c.env);
  // Members, org keys and org ledger die with the org; request_logs rows keep
  // org_id as the audit trail (same policy as deleted users, M8).
  await db.batch([
    db.delete(orgMembers).where(eq(orgMembers.orgId, resolved.org.id)),
    db.delete(apiKeys).where(eq(apiKeys.orgId, resolved.org.id)),
    db.delete(balanceEntries).where(eq(balanceEntries.orgId, resolved.org.id)),
    db.delete(orgs).where(eq(orgs.id, resolved.org.id)),
  ]);
  return c.json({ ok: true });
});

orgApp.post('/orgs/:id/regenerate-code', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can rotate the join code'), 403);
  const db = getDb(c.env);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const joinCode = generateJoinCode();
      await db.update(orgs).set({ joinCode, updatedAt: Date.now() }).where(eq(orgs.id, resolved.org.id));
      return c.json({ join_code: joinCode });
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  throw new Error('unreachable');
});

orgApp.post('/orgs/:id/leave', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role === 'owner') {
    return c.json(apiErr('Owners cannot leave — hand ownership to another member or delete the organization'), 400);
  }
  await getDb(c.env).delete(orgMembers).where(eq(orgMembers.id, resolved.member.id));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ members

orgApp.patch('/orgs/:id/members/:userId', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can change roles'), 403);
  const body = await readJson(c);
  const role = typeof body?.role === 'string' ? body.role : '';
  if (role !== 'owner' && role !== 'member') return c.json(apiErr("role must be 'owner' or 'member'"), 400);
  const db = getDb(c.env);
  const targetUserId = c.req.param('userId');
  const [target] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, resolved.org.id), eq(orgMembers.userId, targetUserId)));
  if (!target) return c.json(apiErr('Member not found'), 404);
  // Last-owner guard: demoting the only owner would orphan the org.
  if (target.role === 'owner' && role !== 'owner' && (await ownerCount(db, resolved.org.id)) <= 1) {
    return c.json(apiErr('Cannot demote the last owner — promote another member first'), 400);
  }
  await db.update(orgMembers).set({ role }).where(eq(orgMembers.id, target.id));
  const [targetUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetUserId));
  return c.json(memberDto({ ...target, role }, targetUser?.email ?? null));
});

orgApp.delete('/orgs/:id/members/:userId', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can remove members'), 403);
  const targetUserId = c.req.param('userId');
  if (targetUserId === c.get('userId')) {
    return c.json(apiErr('Owners cannot remove themselves — hand ownership to another member or delete the organization'), 400);
  }
  const db = getDb(c.env);
  const [target] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, resolved.org.id), eq(orgMembers.userId, targetUserId)));
  if (!target) return c.json(apiErr('Member not found'), 404);
  if (target.role === 'owner' && (await ownerCount(db, resolved.org.id)) <= 1) {
    return c.json(apiErr('Cannot remove the last owner — promote another member first'), 400);
  }
  await db.delete(orgMembers).where(eq(orgMembers.id, target.id));
  return c.json({ ok: true });
});

// --------------------------------------------------------------------- keys

orgApp.get('/orgs/:id/keys', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const db = getDb(c.env);
  const rows = await db
    .select({ key: apiKeys, creatorEmail: users.email })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.orgId, resolved.org.id))
    .orderBy(desc(apiKeys.createdAt));
  const usage = await orgKeyUsage(db, resolved.org.id);
  return c.json(rows.map((r) => orgKeyDto(r.key, usage.get(r.key.id)?.spentUsd ?? 0, usage.get(r.key.id)?.requests ?? 0, r.creatorEmail ?? null)));
});

orgApp.post('/orgs/:id/keys', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
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
    userId: c.get('userId'), // creator attribution — members manage their own keys
    orgId: resolved.org.id, // org scope — draws the org balance at the gateway
    spendLimitUsd: null, // the org balance governs; no per-key caps
    allowedModels: allowedModels ? JSON.stringify(allowedModels) : null,
    enabled: true,
    lastUsedAt: null,
    createdAt: Date.now(),
  };
  await getDb(c.env).insert(apiKeys).values(rec);
  // The raw key rides ONLY in this response — never stored, never logged.
  const [creator] = await getDb(c.env).select({ email: users.email }).from(users).where(eq(users.id, c.get('userId')));
  return c.json({ ...orgKeyDto(rec, 0, 0, creator?.email ?? null), key: raw }, 201);
});

/** Org-key guard: the key must belong to the org; members may only touch keys
 * they created. 404 for both misses (no existence leak). */
async function orgKey(
  env: Env,
  orgId: string,
  me: string,
  role: string,
  keyId: string,
): Promise<typeof apiKeys.$inferSelect | null> {
  const [row] = await getDb(env)
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)));
  if (!row) return null;
  if (role !== 'owner' && row.userId !== me) return null;
  return row;
}

orgApp.patch('/orgs/:id/keys/:keyId', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const existing = await orgKey(c.env, resolved.org.id, c.get('userId'), resolved.member.role, c.req.param('keyId'));
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

  const db = getDb(c.env);
  if (Object.keys(patch).length > 0) {
    await db.update(apiKeys).set(patch).where(eq(apiKeys.id, existing.id));
  }
  const [updated] = await db.select().from(apiKeys).where(eq(apiKeys.id, existing.id));
  const usage = await orgKeyUsage(db, resolved.org.id);
  const [creator] = updated.userId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, updated.userId))
    : [{ email: null }];
  return c.json(orgKeyDto(updated, usage.get(updated.id)?.spentUsd ?? 0, usage.get(updated.id)?.requests ?? 0, creator?.email ?? null));
});

orgApp.delete('/orgs/:id/keys/:keyId', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const existing = await orgKey(c.env, resolved.org.id, c.get('userId'), resolved.member.role, c.req.param('keyId'));
  if (!existing) return c.json(apiErr('API key not found'), 404);
  await getDb(c.env).delete(apiKeys).where(eq(apiKeys.id, existing.id));
  return c.json({ ok: true });
});

// -------------------------------------------------------------------- usage

orgApp.get('/orgs/:id/usage', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const limit = Math.min(200, Math.max(1, Math.round(Number(c.req.query('limit')) || 50)));
  const rows = await getDb(c.env)
    .select()
    .from(requestLogs)
    .where(eq(requestLogs.orgId, resolved.org.id))
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      key_id: r.apiKeyId,
      user_id: r.userId,
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

// ------------------------------------------------------------------ billing

orgApp.get('/orgs/:id/billing', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  const db = getDb(c.env);
  const [entries, billing] = await Promise.all([
    db.select().from(balanceEntries).where(eq(balanceEntries.orgId, resolved.org.id)).orderBy(desc(balanceEntries.createdAt)).limit(100),
    billingConfigStatus(c.env),
  ]);
  return c.json({
    balance_usd: resolved.org.balanceUsdMicros / 1e6,
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

orgApp.post('/orgs/:id/billing/checkout', async (c) => {
  const resolved = await membership(c.env, c.req.param('id'), c.get('userId'));
  if (!resolved) return c.json(apiErr('Organization not found'), 404);
  if (resolved.member.role !== 'owner') return c.json(apiErr('Only org owners can top up the organization'), 403);
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
  const origin = new URL(c.req.url).origin;
  const result = await createLsCheckout({
    storeId: cfg.storeId!,
    variantId: cfg.variantId!,
    apiKey: cfg.apiKey!,
    amountUsdCents: cents,
    userEmail: c.get('user').email,
    orgId: resolved.org.id,
    redirectUrl: `${origin}/app/teams/${resolved.org.id}?topup=success`,
  });
  if (!result.ok) return c.json(apiErr(result.error), 502);
  return c.json({ url: result.url });
});
