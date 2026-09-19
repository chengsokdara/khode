// Khateway Worker entry: mounts /admin (console API), /v1 (gateway), /app/api
// (user portal, M8; orgs/teams, M9), /webhooks (MoR callbacks, M8) and static
// assets for the SPA (admin console + user portal). See docs/plans/mvp-plan.md.
import { Hono } from 'hono';
import type { Env } from './env';
import { adminApp } from './routes/admin';
import { gatewayApp } from './routes/gateway';
import { portalApp } from './routes/portal';
import { orgApp } from './routes/orgs';
import { webhookApp } from './routes/webhooks';
import { RateLimiterDO } from './ratelimit/do';

// Durable Object classes MUST be exported from the entry module (wrangler
// wires the RATE_LIMITER binding to this export).
export { RateLimiterDO };

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, name: 'khateway', time: new Date().toISOString() }));

app.route('/admin', adminApp);
app.route('/v1', gatewayApp);
app.route('/app/api', portalApp);
app.route('/app/api', orgApp);
app.route('/webhooks', webhookApp);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[khateway]', err);
  return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
});

export default app;
