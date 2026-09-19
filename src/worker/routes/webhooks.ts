// /webhooks — inbound MoR (Lemon Squeezy) callbacks (M8). The HMAC signature
// IS the authentication; there is no session or key here.
//
// Idempotency is two-layered:
//   1. `webhook_events` (unique source+event_key) — replays answer
//      {ok, duplicate} without doing anything.
//   2. `balance_entries.ref` (unique, `lemonsqueezy:order:<id>`) — the credit
//      ledger insert throws on a duplicate inside the same D1 batch that bumps
//      the balance, so even a race can never double-credit.
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

  // Idempotency gate #1: record the delivery (duplicate → done).
  try {
    await db.insert(webhookEvents).values({
      id: crypto.randomUUID(),
      source: 'lemonsqueezy',
      eventKey: ev.eventKey,
      eventName: ev.eventName,
      createdAt: Date.now(),
    });
  } catch {
    return c.json({ ok: true, duplicate: true });
  }

  const noteAndFinish = async (note: string, extra: Record<string, unknown> = {}) => {
    await db.update(webhookEvents).set({ note }).where(eq(webhookEvents.eventKey, ev.eventKey));
    return c.json({ ok: true, ...extra });
  };

  if (ev.eventName !== 'order_created') {
    return await noteAndFinish('ignored: unsupported event (only order_created credits)');
  }
  const micros = creditMicros(ev);
  if (micros <= 0) {
    return await noteAndFinish(`ignored: order not creditable (status=${ev.status ?? '?'}, refunded=${ev.refunded})`);
  }

  // Org top-ups (M9): custom_data.org_id wins over user_id when both ride.
  if (ev.orgId) {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, ev.orgId));
    if (!org) return await noteAndFinish(`ignored: unknown org '${ev.orgId}'`);
    try {
      await db.batch([
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
    } catch {
      return c.json({ ok: true, duplicate: true });
    }
    return c.json({ ok: true, credited_usd: micros / 1e6 });
  }

  if (!ev.userId) {
    return await noteAndFinish('ignored: no user_id or org_id in custom_data');
  }
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, ev.userId));
  if (!user) {
    return await noteAndFinish(`ignored: unknown user '${ev.userId}'`);
  }

  // Idempotency gate #2 + credit, atomically: the unique ledger ref aborts the
  // whole batch (no balance change) if this order was ever credited before.
  try {
    await db.batch([
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
  } catch {
    return c.json({ ok: true, duplicate: true });
  }
  return c.json({ ok: true, credited_usd: micros / 1e6 });
});

webhookApp.all('*', (c) => c.json({ error: 'Not found' }, 404));
