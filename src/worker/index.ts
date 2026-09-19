// Khateway Worker entry: mounts /admin (console API), /v1 (gateway), /app/api
// (user portal, M8; orgs/teams, M9), /webhooks (MoR callbacks, M8) and static
// assets for the SPA (admin console + user portal). See docs/plans/mvp-plan.md.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import { adminApp } from './routes/admin';
import { gatewayApp } from './routes/gateway';
import { portalApp } from './routes/portal';
import { orgApp } from './routes/orgs';
import { webhookApp } from './routes/webhooks';
import { clientApiApp } from './routes/clientapi';
import { RateLimiterDO } from './ratelimit/do';

// Durable Object classes MUST be exported from the entry module (wrangler
// wires the RATE_LIMITER binding to this export).
export { RateLimiterDO };

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, name: 'khateway', time: new Date().toISOString() }));

app.route('/admin', adminApp);
app.route('/v1', gatewayApp);
app.route('/api/v1', clientApiApp);
app.route('/app/api', portalApp);
app.route('/app/api', orgApp);
app.route('/webhooks', webhookApp);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[khateway]', err);
  // Never surface raw error text to clients — D1/drizzle messages carry SQL
  // fragments. Callers that need detail live in the server logs. Hono's own
  // HTTPException keeps its status/message; everything else is a generic 500.
  if (err instanceof HTTPException) return err.getResponse();
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
