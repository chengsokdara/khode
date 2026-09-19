// M11 smoke test: semantic cache — against `wrangler dev` on :8787 (needs
// `npm run dev` running first).
//
// Exercises the M11 done-when: repeat prompts hit the cache (logs mark it,
// token savings visible). The mock upstream counts every /chat/completions
// call, so "served from cache" is provable by an unchanged count:
//   1. miss → store → identical repeat is a HIT with no upstream call
//   2. the same canonical request through /v1/messages and /v1/responses hits
//      the SAME entry (the cache key is dialect-independent)
//   3. hits carry x-khateway-cache: HIT, attempts=1, usage + cost in logs
//      with cache_hit=true; misses are logged like any call
//   4. streaming, tools and non-opted models never cache (no header, no entry)
//   5. key-level opt-in caches even for a non-opted model; the cache is
//      shared across keys (same model + same canonical request → hit)
//   6. master switch off → nothing cached; TTL expiry → miss again; admin
//      flush drops every entry immediately
// Settings are TTL-cached (5 s) per isolate — each settings toggle is followed
// by a settle wait. Fixtures are named `M11 … (smoke)` and self-cleaned; the
// dev DB request_logs are cleared at start and cleanup. Run only on dev DBs.
import http from 'node:http';

const base = 'http://127.0.0.1:8787';
let failures = 0;
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
};
const pass = (name, detail = '') => console.log(`PASS — ${name}${detail ? ` [${detail}]` : ''}`);
const check = (name, cond, detail = '') => (cond ? pass(name, detail) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
const j = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.includes('khateway_session=') && !setCookie.includes('Max-Age=0')) {
    cookie = `khateway_session=${setCookie.split('khateway_session=')[1].split(';')[0]}`;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body, headers: res.headers };
};

// ------------------------------------------------------------ mock upstream

const upstreamCalls = []; // raw JSON bodies of every /chat/completions POST

function startMockUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) || {};
      } catch {
        body = {};
      }
      if (req.url.includes('/chat/completions')) {
        upstreamCalls.push(JSON.stringify(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-m11',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'm11 mock reply' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------- fixtures

const PROVIDER_NAME = 'Khateway M11 Mock (smoke)';
const SLUG_CACHED = 'm11-cache-smoke'; // cache_enabled: true
const SLUG_PLAIN = 'm11-plain-smoke'; // cache_enabled: false
const KEY_A = 'M11 Key A (smoke)';
const KEY_B = 'M11 Key B cache (smoke)';

async function deleteIfExists(path, listFilter) {
  const list = await j(path);
  for (const row of list.body ?? []) {
    if (listFilter(row)) await j(`${path}/${row.id}`, { method: 'DELETE' });
  }
}

async function cleanup() {
  for (const name of [KEY_A, KEY_B]) await deleteIfExists('/admin/api-keys', (k) => k.name === name);
  await deleteIfExists('/admin/models', (m) => [SLUG_CACHED, SLUG_PLAIN].includes(m.slug));
  await deleteIfExists('/admin/providers', (p) => p.name === PROVIDER_NAME);
  await j('/admin/logs', { method: 'DELETE' });
  await j('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({ cache_enabled: 'off', cache_ttl_seconds: 3600, rate_limit_enabled: 'off' }),
  });
}

// ---------------------------------------------------------------- callers

const openai = (slug, key, extra = {}) =>
  fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: slug, max_tokens: 16, messages: [{ role: 'user', content: 'hello m11' }], ...extra }),
  });

const anthropic = (slug, key) =>
  fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: slug, max_tokens: 16, messages: [{ role: 'user', content: 'hello m11' }] }),
  });

const responses = (slug, key) =>
  fetch(base + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: slug, max_output_tokens: 16, input: 'hello m11' }),
  });

const upstreamCount = () => upstreamCalls.length;

// ------------------------------------------------------------------- the run

(async () => {
  const mock = await startMockUpstream();
  const login = await j('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) });
  if (login.status !== 200) {
    fail('admin login (is `npm run dev` running on :8787?)', `status=${login.status}`);
    process.exitCode = 1;
    return;
  }

  await cleanup();
  upstreamCalls.length = 0;

  // --- config: cache ON at 3600 s, rate limiting off, fixtures --------------
  const badTtl = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ cache_ttl_seconds: 0 }) });
  check('PATCH settings rejects cache_ttl_seconds 0 → 400', badTtl.status === 400, JSON.stringify(badTtl.body));

  const settings = await j('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({ cache_enabled: 'on', cache_ttl_seconds: 3600, rate_limit_enabled: 'off' }),
  });
  check(
    'PATCH settings → cache on (ttl 3600), rate limiting off',
    settings.status === 200 && settings.body?.cache_enabled === 'on' && settings.body?.cache_ttl_seconds === 3600,
    JSON.stringify(settings.body),
  );

  const prov = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: PROVIDER_NAME, adapter: 'openai', base_url: `http://127.0.0.1:${mock.port}/v1` }),
  });
  check('create smoke provider', prov.status === 201, JSON.stringify(prov.body));

  const modelCached = await j('/admin/models', {
    method: 'POST',
    body: JSON.stringify({ provider_id: prov.body.id, slug: SLUG_CACHED, cache_enabled: true, pricing_input: 2, pricing_output: 8 }),
  });
  check('create cache-opted model (cache_enabled: true, priced 2/8)', modelCached.status === 201 && modelCached.body?.cache_enabled === true, JSON.stringify(modelCached.body));
  const modelPlain = await j('/admin/models', {
    method: 'POST',
    body: JSON.stringify({ provider_id: prov.body.id, slug: SLUG_PLAIN, cache_enabled: false }),
  });
  check('create non-opted model (cache_enabled: false)', modelPlain.status === 201 && modelPlain.body?.cache_enabled === false, JSON.stringify(modelPlain.body));

  const keyA = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: KEY_A }) });
  check('create key A (no cache flag)', keyA.status === 201 && keyA.body?.cache_enabled === false, JSON.stringify(keyA.body));
  const keyB = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: KEY_B, cache_enabled: true }) });
  check('create key B (cache_enabled: true)', keyB.status === 201 && keyB.body?.cache_enabled === true, JSON.stringify(keyB.body));

  // Settings are TTL-cached (5 s) per isolate — wait out the window.
  await sleep(5300);

  // --- 1. miss → store → repeat hits ---------------------------------------
  const c1 = await openai(SLUG_CACHED, keyA.body.key);
  check('first call → 200 MISS', c1.status === 200 && c1.headers.get('x-khateway-cache') === 'MISS', `status=${c1.status} cache=${c1.headers.get('x-khateway-cache')}`);
  check('first call reached the upstream once', upstreamCount() === 1, String(upstreamCount()));
  const c1body = await c1.json();

  const c2 = await openai(SLUG_CACHED, keyA.body.key);
  const c2body = await c2.json();
  check('identical repeat → 200 HIT (no upstream call)', c2.status === 200 && c2.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 1, `cache=${c2.headers.get('x-khateway-cache')} upstream=${upstreamCount()}`);
  check('hit serves the same content as the miss', c2body?.choices?.[0]?.message?.content === c1body?.choices?.[0]?.message?.content);
  check('hit reports attempts=1 + usage from the cached payload', c2.headers.get('x-khateway-attempts') === '1' && c2body?.usage?.prompt_tokens === 12 && c2body?.usage?.completion_tokens === 7);

  // --- 2. dialect independence: same canonical request via the other faces --
  const c3 = await anthropic(SLUG_CACHED, keyA.body.key);
  const c3body = await c3.json();
  check(
    'anthropic face, same canonical request → HIT with translated body',
    c3.status === 200 && c3.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 1 && c3body?.content?.[0]?.text === 'm11 mock reply',
    `status=${c3.status} cache=${c3.headers.get('x-khateway-cache')} upstream=${upstreamCount()}`,
  );

  const c4 = await responses(SLUG_CACHED, keyA.body.key);
  const c4body = await c4.json();
  check(
    'responses face, same canonical request → HIT with Responses body',
    c4.status === 200 && c4.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 1 && c4body?.status === 'completed',
    `status=${c4.status} cache=${c4.headers.get('x-khateway-cache')} upstream=${upstreamCount()}`,
  );

  // --- 3. logs mark hits with usage + cost ----------------------------------
  const logs = await j(`/admin/logs?model=${SLUG_CACHED}&limit=50`);
  const rows = (logs.body ?? []).filter((r) => r.status === 200 && r.dialect !== undefined);
  const hitRows = rows.filter((r) => r.cache_hit === true);
  const missRows = rows.filter((r) => r.cache_hit === false);
  check('request_logs: exactly 1 miss + 3 hits for the cached model', missRows.length === 1 && hitRows.length === 3, `miss=${missRows.length} hit=${hitRows.length}`);
  const missRow = missRows[0];
  const hitRow = hitRows[0];
  check(
    'hit rows carry usage 12/7 + exact priced cost (2/8 per 1M)',
    hitRow?.tokens_in === 12 && hitRow?.tokens_out === 7 && Math.abs(hitRow?.cost_usd - 0.00008) < 1e-9,
    JSON.stringify(hitRow),
  );
  check('miss row logged the same usage (cached replay reproduces it)', missRow?.tokens_in === 12 && missRow?.tokens_out === 7);

  // --- 4. streaming / tools / non-opted model never cache --------------------
  const s1 = await openai(SLUG_CACHED, keyA.body.key, { stream: true });
  await s1.text();
  const s2 = await openai(SLUG_CACHED, keyA.body.key, { stream: true });
  await s2.text();
  check(
    'streamed calls bypass the cache (no header, 2 fresh upstream calls)',
    s1.headers.get('x-khateway-cache') === null && s2.headers.get('x-khateway-cache') === null && upstreamCount() === 3,
    `upstream=${upstreamCount()}`,
  );

  const again = await openai(SLUG_CACHED, keyA.body.key);
  check('non-streaming call after streams → still a HIT (streams never stored)', again.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 3, `upstream=${upstreamCount()}`);

  const t1 = await openai(SLUG_CACHED, keyA.body.key, { tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } }] });
  const t2 = await openai(SLUG_CACHED, keyA.body.key, { tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } }] });
  check(
    'tool requests bypass the cache (no header, 2 fresh upstream calls)',
    t1.headers.get('x-khateway-cache') === null && t2.headers.get('x-khateway-cache') === null && upstreamCount() === 5,
    `upstream=${upstreamCount()}`,
  );

  const p1 = await openai(SLUG_PLAIN, keyA.body.key);
  const p2 = await openai(SLUG_PLAIN, keyA.body.key);
  check(
    'non-opted model never caches (no header, 2 fresh upstream calls)',
    p1.headers.get('x-khateway-cache') === null && p2.headers.get('x-khateway-cache') === null && upstreamCount() === 7,
    `upstream=${upstreamCount()}`,
  );

  // --- 5. key-level opt-in + shared cache -----------------------------------
  const k1 = await openai(SLUG_PLAIN, keyB.body.key);
  check('key-level opt-in: first call on a non-opted model → MISS', k1.status === 200 && k1.headers.get('x-khateway-cache') === 'MISS' && upstreamCount() === 8, `upstream=${upstreamCount()}`);
  const k2 = await openai(SLUG_PLAIN, keyB.body.key);
  check('key-level opt-in: identical repeat → HIT', k2.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 8, `upstream=${upstreamCount()}`);
  const k3 = await openai(SLUG_CACHED, keyB.body.key);
  check('cache is shared across keys (key B hits key A’s stored entry)', k3.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 8, `upstream=${upstreamCount()}`);

  // a changed option → different key
  const v1 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 17 });
  const v2 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 17 });
  check(
    'changed max_tokens → separate entry (miss then hit)',
    v1.headers.get('x-khateway-cache') === 'MISS' && v2.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 9,
    `upstream=${upstreamCount()}`,
  );

  // --- 6. master switch off → nothing cached ---------------------------------
  await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ cache_enabled: 'off' }) });
  await sleep(5300);
  const off1 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 18 });
  const off2 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 18 });
  check(
    'master switch off → no caching even on an opted model',
    off1.headers.get('x-khateway-cache') === null && off2.headers.get('x-khateway-cache') === null && upstreamCount() === 11,
    `upstream=${upstreamCount()}`,
  );

  // --- 7. TTL expiry + admin flush -------------------------------------------
  await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ cache_enabled: 'on', cache_ttl_seconds: 1 }) });
  await sleep(5300);
  const flushAll = await j('/admin/cache/flush', { method: 'POST' });
  check('admin flush clears prior entries', flushAll.status === 200 && flushAll.body?.ok === true && flushAll.body?.flushed > 0, JSON.stringify(flushAll.body));

  const e1 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 19 });
  const e2 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 19 });
  check('ttl=1s: miss then immediate hit', e1.headers.get('x-khateway-cache') === 'MISS' && e2.headers.get('x-khateway-cache') === 'HIT' && upstreamCount() === 12, `upstream=${upstreamCount()}`);

  await sleep(1600);
  const e3 = await openai(SLUG_CACHED, keyA.body.key, { max_tokens: 19 });
  check('ttl=1s: entry expired → MISS again (fresh upstream call)', e3.headers.get('x-khateway-cache') === 'MISS' && upstreamCount() === 13, `upstream=${upstreamCount()}`);

  const flushed = await j('/admin/cache/flush', { method: 'POST' });
  const statsAfterFlush = await j('/admin/cache');
  check('flush again → stats show 0 entries / 0 bytes', flushed.body?.flushed >= 1 && statsAfterFlush.body?.entries === 0 && statsAfterFlush.body?.bytes === 0, JSON.stringify(statsAfterFlush.body));

  const stats = await j('/admin/cache');
  check(
    'stats: 24 h savings visible (hits + cached tokens counted)',
    stats.body?.hits_24h >= 5 && stats.body?.tokens_cached_24h > 0,
    JSON.stringify(stats.body),
  );

  // --- cleanup ----------------------------------------------------------------
  mock.server.close();
  await cleanup();
  const postStats = await j('/admin/cache');
  if (postStats.body?.entries !== 0) await j('/admin/cache/flush', { method: 'POST' });

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exitCode = 1;
});
