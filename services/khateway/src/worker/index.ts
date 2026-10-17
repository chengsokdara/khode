// Khateway Worker entry: mounts /api/admin (console API), /v1 (gateway),
// /api/portal (user portal, M8; orgs/teams, M9), /api/v1 (client key/credit
// API, M16), /webhooks (MoR callbacks, M8). /admin and /app are pure SPA page
// prefixes served straight from the assets layer (see wrangler.jsonc).
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import { adminApp } from './routes/admin';
import { gatewayApp } from './routes/gateway';
import { portalApp } from './routes/portal';
import { orgApp } from './routes/orgs';
import { oauthApp } from './routes/oauth';
import { webhookApp } from './routes/webhooks';
import { clientApiApp } from './routes/clientapi';
import { deviceApp } from './routes/device';
import { RateLimiterDO } from './ratelimit/do';
import { runModelsSync } from './models-sync';

// Durable Object classes MUST be exported from the entry module (wrangler
// wires the RATE_LIMITER binding to this export).
export { RateLimiterDO };

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, name: 'khateway', time: new Date().toISOString() }));

app.route('/api/admin', adminApp);
app.route('/v1', gatewayApp);
// Device flow mounts DEEPER than /api/v1 and registers before it, so the
// client API's `all('*')` key-required catch-all can never swallow the
// (deliberately keyless) device endpoints.
app.route('/api/v1/device', deviceApp);
app.route('/api/v1', clientApiApp);
// Social sign-in mounts DEEPER than /api/portal and registers before it, so
// the portal's portalAuth catch-all middleware can never swallow its
// anonymous /start + /callback routes (same ordering rule as device vs clientapi).
app.route('/api/portal/oauth', oauthApp);
app.route('/api/portal', portalApp);
app.route('/api/portal', orgApp);
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

// Cron trigger (wrangler.jsonc triggers.crons): the daily 03:17 UTC free-models
// sync. The Worker exports a fetch/scheduled pair instead of the bare Hono app
// so the runtime can invoke both entry points.
export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    console.log('[khateway] scheduled', event.cron);
    ctx.waitUntil(runModelsSync(env, 'cron'));
  },
};
