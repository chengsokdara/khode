// End-to-end smoke test for the /admin API against `wrangler dev` on :8787.
// Usage: node scripts/smoke.mjs   (server must be running)
const base = 'http://127.0.0.1:8787';
let cookie = '';

const j = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc && sc.includes('khateway_session=') && !sc.includes('Max-Age=0')) {
    cookie = sc.split(';')[0];
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body };
};

(async () => {
  console.log('health:', (await j('/health')).status);

  // Static serving: / is the public landing page and /admin/* is the console
  // SPA — both come from the assets layer, the worker is never invoked.
  const landing = await fetch(base + '/');
  console.log('GET / (expect 200 text/html):', landing.status, landing.headers.get('content-type')?.split(';')[0]);
  const adminPage = await fetch(base + '/admin/overview');
  console.log('GET /admin/overview (expect 200 text/html — SPA fallback):', adminPage.status, adminPage.headers.get('content-type')?.split(';')[0]);

  console.log('unauth /api/admin/overview (expect 401):', (await j('/api/admin/overview')).status);
  console.log('bad login (expect 401):', (await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status);
  console.log('login (expect 200):', (await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) })).status);
  console.log('overview:', JSON.stringify((await j('/api/admin/overview')).body));

  const list = await j('/api/admin/providers');
  console.log('providers list:', list.status, `count=${list.body?.length}`);

  if (list.body?.length === 0) {
    const created = await j('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'DeepSeek', adapter: 'openai', base_url: 'https://api.deepseek.com/v1' }),
    });
    const p = created.body;
    console.log('create provider:', created.status, `id=${p?.id}`);

    const model = await j('/api/admin/models', {
      method: 'POST',
      body: JSON.stringify({
        provider_id: p.id,
        slug: 'ds-chat',
        display_name: 'DeepSeek Chat',
        upstream_model: 'deepseek-chat',
        context_window: 65536,
        pricing_input: 0.27,
        pricing_output: 1.1,
        capabilities: ['streaming', 'tools'],
      }),
    });
    const m = model.body;
    console.log('create model:', model.status, `${m?.slug} -> ${m?.upstream_model}`);

    console.log('patch model enabled=false →', (await j(`/api/admin/models/${m.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).body.enabled);
    console.log('models list count:', (await j('/api/admin/models')).body?.length);

    const dup = await j('/api/admin/models', { method: 'POST', body: JSON.stringify({ provider_id: p.id, slug: 'ds-chat' }) });
    console.log('duplicate slug →', dup.status, dup.body?.error);

    console.log('bad adapter →', (await j('/api/admin/providers', { method: 'POST', body: JSON.stringify({ name: 'X', adapter: 'yeet' }) })).status);

    // Dual-dialect provider: one row speaking both upstream dialects.
    const dual = await j('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'OpenRouter', adapters: ['openai', 'anthropic'], base_url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-test' }),
    });
    console.log('create dual-adapter provider:', dual.status, JSON.stringify({ adapter: dual.body?.adapter, adapters: dual.body?.adapters }));
    console.log('legacy adapter patch (single string) →', (await j(`/api/admin/providers/${dual.body?.id}`, { method: 'PATCH', body: JSON.stringify({ adapter: 'anthropic' }) })).body?.adapters);
    console.log('bad adapters array →', (await j('/api/admin/providers', { method: 'POST', body: JSON.stringify({ name: 'X', adapters: ['openai', 'yeet'] }) })).status);
    console.log('delete dual provider →', (await j(`/api/admin/providers/${dual.body?.id}`, { method: 'DELETE' })).status);

    console.log('test connection →', JSON.stringify((await j(`/api/admin/providers/${p.id}/test`, { method: 'POST' })).body));

    console.log('delete model →', (await j(`/api/admin/models/${m.id}`, { method: 'DELETE' })).status);
    console.log('delete provider →', (await j(`/api/admin/providers/${p.id}`, { method: 'DELETE' })).status);
  }

  console.log('final overview:', JSON.stringify((await j('/api/admin/overview')).body));

  // --- M7: api keys + logs --------------------------------------------------
  // Self-clean stale smoke keys from crashed runs (user keys never end in "(smoke)").
  for (const k of (await j('/api/admin/api-keys')).body ?? []) {
    if (k.name?.endsWith('(smoke)')) await j(`/api/admin/api-keys/${k.id}`, { method: 'DELETE' });
  }

  const keyCreate = await j('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Admin Smoke (smoke)', spend_limit_usd: 5, allowed_models: ['ds-chat'] }) });
  console.log('create api key:', keyCreate.status, `prefix=${keyCreate.body?.key_prefix}`, `raw=${keyCreate.body?.key?.slice(0, 9)}…`);
  const keyRaw = keyCreate.body?.key;

  console.log('api keys list:', JSON.stringify((await j('/api/admin/api-keys')).body?.map((k) => ({ name: k.name, prefix: k.key_prefix, limit: k.spend_limit_usd, allowed: k.allowed_models }))));

  const keyPatch = await j(`/api/admin/api-keys/${keyCreate.body.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Admin Smoke Renamed (smoke)', spend_limit_usd: null }) });
  console.log('patch api key:', keyPatch.status, keyPatch.body?.name, 'limit=', keyPatch.body?.spend_limit_usd);

  console.log('bad api key name (expect 400):', (await j('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: '' }) })).status);
  console.log('bad spend limit (expect 400):', (await j('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'x', spend_limit_usd: -1 }) })).status);

  if (keyRaw) {
    // Keyless-native default: no auth header (or the `anonymous` sentinel) is served;
    // enforcement mode (admin settings) restores strict 401s.
    console.log('gateway keyless (expect 200 without key):', (await fetch(`${base}/v1/models`)).status);
    console.log('gateway keyless (expect 200 with anonymous):', (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer anonymous' } })).status);
    console.log('gateway auth works (expect 200 with key):', (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${keyRaw}` } })).status);
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyRaw}` },
      body: JSON.stringify({ model: 'zzz-no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    console.log('gateway loggable request (expect 404 model):', chat.status);
    await new Promise((r) => setTimeout(r, 500));
    console.log('logs after request:', JSON.stringify((await j('/api/admin/logs?limit=5')).body?.map((l) => ({ model: l.model_slug, status: l.status, key: l.key_name }))));
  }

  // --- usage dashboard endpoint (aggregates over request_logs) ---------------
  {
    const unauth = await fetch(base + '/api/admin/usage');
    console.log('unauth /api/admin/usage (expect 401):', unauth.status);

    if (keyRaw) {
      const clamped = await j('/api/admin/usage?days=99999');
      console.log('usage days clamp (expect bucket=day):', clamped.body?.bucket);

      const u1 = await j('/api/admin/usage?days=1');
      const u7 = await j('/api/admin/usage?days=7');
      const ok =
        u1.status === 200 &&
        u1.body?.bucket === 'hour' &&
        u1.body?.series?.length === 24 &&
        u7.body?.bucket === 'day' &&
        u7.body?.series?.length === 7 &&
        typeof u7.body?.totals?.requests === 'number' &&
        u7.body.totals.requests >= 1 &&
        u7.body?.prev_totals != null &&
        Array.isArray(u7.body?.by_model) &&
        u7.body.by_model.some((m) => m.model_slug === 'zzz-no-such-model') &&
        Array.isArray(u7.body?.by_key) &&
        Array.isArray(u7.body?.by_dialect);
      console.log(
        'usage dashboard (expect ok):',
        ok,
        JSON.stringify({
          bucket1: u1.body?.bucket,
          series1: u1.body?.series?.length,
          bucket7: u7.body?.bucket,
          series7: u7.body?.series?.length,
          requests: u7.body?.totals?.requests,
          errors: (u7.body?.totals?.errors_4xx ?? 0) + (u7.body?.totals?.errors_5xx ?? 0),
          models: u7.body?.by_model?.length,
          keys: u7.body?.by_key?.length,
          dialects: u7.body?.by_dialect?.length,
        }),
      );
      if (!ok) throw new Error('usage dashboard checks failed');
    }
  }

  console.log('clear logs:', (await j('/api/admin/logs', { method: 'DELETE' })).status);
  console.log('delete api key:', (await j(`/api/admin/api-keys/${keyCreate.body.id}`, { method: 'DELETE' })).status);

  console.log('logout:', (await j('/api/admin/logout', { method: 'POST' })).status);
  console.log('overview after logout (expect 401):', (await j('/api/admin/overview')).status);
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
