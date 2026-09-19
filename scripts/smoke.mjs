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

  console.log('unauth /admin/overview (expect 401):', (await j('/admin/overview')).status);
  console.log('bad login (expect 401):', (await j('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status);
  console.log('login (expect 200):', (await j('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) })).status);
  console.log('overview:', JSON.stringify((await j('/admin/overview')).body));

  const list = await j('/admin/providers');
  console.log('providers list:', list.status, `count=${list.body?.length}`);

  if (list.body?.length === 0) {
    const created = await j('/admin/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'DeepSeek', adapter: 'openai', base_url: 'https://api.deepseek.com/v1' }),
    });
    const p = created.body;
    console.log('create provider:', created.status, `id=${p?.id}`);

    const model = await j('/admin/models', {
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

    console.log('patch model enabled=false →', (await j(`/admin/models/${m.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).body.enabled);
    console.log('models list count:', (await j('/admin/models')).body?.length);

    const dup = await j('/admin/models', { method: 'POST', body: JSON.stringify({ provider_id: p.id, slug: 'ds-chat' }) });
    console.log('duplicate slug →', dup.status, dup.body?.error);

    console.log('bad adapter →', (await j('/admin/providers', { method: 'POST', body: JSON.stringify({ name: 'X', adapter: 'yeet' }) })).status);

    // Dual-dialect provider: one row speaking both upstream dialects.
    const dual = await j('/admin/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'OpenRouter', adapters: ['openai', 'anthropic'], base_url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-test' }),
    });
    console.log('create dual-adapter provider:', dual.status, JSON.stringify({ adapter: dual.body?.adapter, adapters: dual.body?.adapters }));
    console.log('legacy adapter patch (single string) →', (await j(`/admin/providers/${dual.body?.id}`, { method: 'PATCH', body: JSON.stringify({ adapter: 'anthropic' }) })).body?.adapters);
    console.log('bad adapters array →', (await j('/admin/providers', { method: 'POST', body: JSON.stringify({ name: 'X', adapters: ['openai', 'yeet'] }) })).status);
    console.log('delete dual provider →', (await j(`/admin/providers/${dual.body?.id}`, { method: 'DELETE' })).status);

    console.log('test connection →', JSON.stringify((await j(`/admin/providers/${p.id}/test`, { method: 'POST' })).body));

    console.log('delete model →', (await j(`/admin/models/${m.id}`, { method: 'DELETE' })).status);
    console.log('delete provider →', (await j(`/admin/providers/${p.id}`, { method: 'DELETE' })).status);
  }

  console.log('final overview:', JSON.stringify((await j('/admin/overview')).body));

  // --- M7: api keys + logs --------------------------------------------------
  // Self-clean stale smoke keys from crashed runs (user keys never end in "(smoke)").
  for (const k of (await j('/admin/api-keys')).body ?? []) {
    if (k.name?.endsWith('(smoke)')) await j(`/admin/api-keys/${k.id}`, { method: 'DELETE' });
  }

  const keyCreate = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Admin Smoke (smoke)', spend_limit_usd: 5, allowed_models: ['ds-chat'] }) });
  console.log('create api key:', keyCreate.status, `prefix=${keyCreate.body?.key_prefix}`, `raw=${keyCreate.body?.key?.slice(0, 9)}…`);
  const keyRaw = keyCreate.body?.key;

  console.log('api keys list:', JSON.stringify((await j('/admin/api-keys')).body?.map((k) => ({ name: k.name, prefix: k.key_prefix, limit: k.spend_limit_usd, allowed: k.allowed_models }))));

  const keyPatch = await j(`/admin/api-keys/${keyCreate.body.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Admin Smoke Renamed (smoke)', spend_limit_usd: null }) });
  console.log('patch api key:', keyPatch.status, keyPatch.body?.name, 'limit=', keyPatch.body?.spend_limit_usd);

  console.log('bad api key name (expect 400):', (await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: '' }) })).status);
  console.log('bad spend limit (expect 400):', (await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'x', spend_limit_usd: -1 }) })).status);

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
    console.log('logs after request:', JSON.stringify((await j('/admin/logs?limit=5')).body?.map((l) => ({ model: l.model_slug, status: l.status, key: l.key_name }))));
  }

  console.log('clear logs:', (await j('/admin/logs', { method: 'DELETE' })).status);
  console.log('delete api key:', (await j(`/admin/api-keys/${keyCreate.body.id}`, { method: 'DELETE' })).status);

  console.log('logout:', (await j('/admin/logout', { method: 'POST' })).status);
  console.log('overview after logout (expect 401):', (await j('/admin/overview')).status);
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
