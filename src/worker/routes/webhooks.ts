// /webhooks — inbound MoR (Lemon Squeezy) callbacks (M8). The HMAC signature
// IS the authentication; there is no session or key here.
//
// Idempotency is two-layered (M15 hardening):
//   1. `webhook_events` (unique source+event_key) — replays answer
//      {ok, duplicate} without doing anything.
//   2. `balance_entries.ref` (unique, `lemonsqueezy:order:<id>`) — the credit
//      ledger insert throws on a duplicate inside the same D1 batch that bumps
//      the balance, so even a race can never double-credit.
// For crediting outcomes BOTH bookkeeping rows are written in the SAME atomic
// batch as the balance bump: a transient D1 failure must leave nothing
// recorded, so the 500 we answer makes Lemon Squeezy retry into a clean
// state. Recording the delivery separately from the credit would let a crash
// between the two permanently block the retry as a "duplicate" — a silently
// lost top-up. Only genuine unique-violations may answer duplicate; any other
// error must propagate as a 5xx.
// Anything that parses and verifies but does not apply (unknown user, non-paid
// status, ignored event) is still recorded with a `note` and answered 200 —
// non-2xx would make Lemon Squeezy retry forever.
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { balanceEntries, orgs, users, webhookEvents } from '../db/schema';
import { getBillingConfig } from '../billing/config';
import { creditMicros, lsSignatureValid, parseLsWebhook } from '../billing/lemonsqueezy';

export const webhookApp = new Hono<{ Bindings: Env }>();

// D1 surfaces constraint violations as "UNIQUE constraint failed:
// <table>.<col>"; drizzle wraps the driver error, so walk the cause chain.
// The trailing dot keeps the table match exact (no prefix collisions).
export function isUniqueViolation(err: unknown, table: string): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    if (e.message.includes(`UNIQUE constraint failed: ${table}.`)) return true;
    e = e.cause;
  }
  return false;
}

webhookApp.post('/lemonsqueezy', async (c) => {
  const raw = await c.req.text();
  const cfg = await getBillingConfig(c.env);
  if (!cfg.webhookSecret) {
    // Not configured: reject so the sender retries once the admin sets the secret.
    return c.json({ error: 'Webhook signing secret is not configured' }, 500);
  }
  if (!(await lsSignatureValid(cfg.webhookSecret, raw, c.req.header('x-signature')))) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const ev = parseLsWebhook(body);
  if (!ev) return c.json({ error: 'Unrecognized Lemon Squeezy payload' }, 400);

  const db = getDb(c.env);

  // Non-crediting outcome: record the delivery with its note, answer 200.
  // A replay of a recorded outcome is a duplicate; any other insert failure
  // propagates (500 → Lemon Squeezy retries; nothing is recorded mid-flight).
  const recordIgnored = async (note: string) => {
    try {
      await db.insert(webhookEvents).values({
        id: crypto.randomUUID(),
        source: 'lemonsqueezy',
        eventKey: ev.eventKey,
        eventName: ev.eventName,
        note,
        createdAt: Date.now(),
      });
    } catch (err) {
      if (isUniqueViolation(err, 'webhook_events')) {
        return c.json({ ok: true, duplicate: true });
      }
      throw err;
    }
    return c.json({ ok: true });
  };

  if (ev.eventName !== 'order_created') {
    return await recordIgnored('ignored: unsupported event (only order_created credits)');
  }
  const micros = creditMicros(ev);
  if (micros <= 0) {
    return await recordIgnored(`ignored: order not creditable (status=${ev.status ?? '?'}, refunded=${ev.refunded})`);
  }

  // Org top-ups (M9): custom_data.org_id wins over user_id when both ride.
  if (ev.orgId) {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, ev.orgId));
    if (!org) return await recordIgnored(`ignored: unknown org '${ev.orgId}'`);
    try {
      await db.batch([
        db.insert(webhookEvents).values({
          id: crypto.randomUUID(),
          source: 'lemonsqueezy',
          eventKey: ev.eventKey,
          eventName: ev.eventName,
          createdAt: Date.now(),
        }),
        db.insert(balanceEntries).values({
          id: crypto.randomUUID(),
          orgId: org.id,
          deltaUsdMicros: micros,
          kind: 'topup',
          ref: `lemonsqueezy:order:${ev.orderId}`,
          note: `Lemon Squeezy order ${ev.orderId}${ev.currency ? ` (${ev.currency})` : ''}`,
          createdAt: Date.now(),
        }),
        db
          .update(orgs)
          .set({ balanceUsdMicros: sql`${orgs.balanceUsdMicros} + ${micros}`, updatedAt: Date.now() })
          .where(eq(orgs.id, org.id)),
      ]);
    } catch (err) {
      if (isUniqueViolation(err, 'webhook_events') || isUniqueViolation(err, 'balance_entries')) {
        return c.json({ ok: true, duplicate: true });
      }
      throw err;
    }
    return c.json({ ok: true, credited_usd: micros / 1e6 });
  }

  if (!ev.userId) {
    return await recordIgnored('ignored: no user_id or org_id in custom_data');
  }
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, ev.userId));
  if (!user) {
    return await recordIgnored(`ignored: unknown user '${ev.userId}'`);
  }

  // Credit, atomically: the unique ledger ref aborts the whole batch (no
  // balance change) if this order was ever credited before.
  try {
    await db.batch([
      db.insert(webhookEvents).values({
        id: crypto.randomUUID(),
        source: 'lemonsqueezy',
        eventKey: ev.eventKey,
        eventName: ev.eventName,
        createdAt: Date.now(),
      }),
      db.insert(balanceEntries).values({
        id: crypto.randomUUID(),
        userId: user.id,
        deltaUsdMicros: micros,
        kind: 'topup',
        ref: `lemonsqueezy:order:${ev.orderId}`,
        note: `Lemon Squeezy order ${ev.orderId}${ev.currency ? ` (${ev.currency})` : ''}`,
        createdAt: Date.now(),
      }),
      db
        .update(users)
        .set({ balanceUsdMicros: sql`${users.balanceUsdMicros} + ${micros}`, updatedAt: Date.now() })
        .where(eq(users.id, user.id)),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, 'webhook_events') || isUniqueViolation(err, 'balance_entries')) {
      return c.json({ ok: true, duplicate: true });
    }
    throw err;
  }
  return c.json({ ok: true, credited_usd: micros / 1e6 });
});

webhookApp.all('*', (c) => c.json({ error: 'Not found' }, 404));
