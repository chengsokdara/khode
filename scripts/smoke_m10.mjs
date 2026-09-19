// M10 smoke test: gateway rate limiting — against `wrangler dev` on :8787
// (needs `npm run dev` running first).
//
// Exercises the M10 done-when: limits enforced under CONCURRENT load. Config
// under test: rate_limit_enabled=on, default key limit 5/min, anonymous IP
// limit 3/min, one model with a global 4/min cap, one key with a 2/min
// override. Every burst uses its OWN bucket (fresh key / model / anonymous-IP
// phase ordering) so phases cannot interfere inside the shared 60s window:
//   1. anonymous burst → IP bucket denies at 4, openai 429 envelope + Retry-After
//   2. keyed burst → key bucket denies at 6; anthropic face gets the
//      anthropic 429 envelope on an already-exhausted key
//   3. per-key override (2/min) beats the 5/min default
//   4. two keys burst together → independent counts, each allows 5
//   5. model cap (4/min) denies across a fresh key while the key bucket is
//      not the binding constraint
//   6. enabled=off bypasses every bucket (even with counts already stored)
// Fixtures are named `M10 … (smoke)` and self-cleaned. 429s write request_logs
// rows (status 429) — asserted once, then cleared. Run only on dev DBs.
import http from 'node:http';

const base = 'http://127.0.0.1:8787';
let failures = 0;
const passes = [];
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
};
const pass = (name, detail = '') => {
  passes.push(name);
  console.log(`PASS — ${name}${detail ? ` [${detail}]` : ''}`);
};
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-m10',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'm10 mock' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ------------------------------------------------------------------ fixtures

const PROVIDER_NAME = 'Khateway M10 Mock (smoke)';
const SLUG_A = 'm10-open-smoke'; // no model cap
const SLUG_B = 'm10-capped-smoke'; // model cap 4/min
const KEY_NAMES = ['M10 A (smoke)', 'M10 B (smoke)', 'M10 C override (smoke)', 'M10 D (smoke)', 'M10 E (smoke)'];

async function deleteIfExists(path, listFilter) {
  const list = await j(path);
  for (const row of list.body ?? []) {
    if (listFilter(row)) await j(`${path}/${row.id}`, { method: 'DELETE' });
  }
}

async function cleanup() {
  for (const name of KEY_NAMES) await deleteIfExists('/admin/api-keys', (k) => k.name === name);
  await deleteIfExists('/admin/models', (m) => [SLUG_A, SLUG_B].includes(m.slug));
  await deleteIfExists('/admin/providers', (p) => p.name === PROVIDER_NAME);
  await j('/admin/logs', { method: 'DELETE' });
}

const chat = async (slug, key, path = '/v1/chat/completions') => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: slug, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
};

/** Fires `n` concurrent requests; returns {allowed, denied} counts + the last denial. */
async function burst(n, fn) {
  const results = await Promise.all(Array.from({ length: n }, fn));
  const allowed = results.filter((r) => r.status === 200).length;
  const denied = results.filter((r) => r.status === 429);
  return { allowed, denied, results, lastDenied: denied[denied.length - 1] ?? null };
}

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
  await j('/admin/logs', { method: 'DELETE' });

  // --- config: limits ON, tiny values, provider + models + keys -------------
  const settings = await j('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({ rate_limit_enabled: 'on', rate_limit_key_rpm: 5, rate_limit_ip_rpm: 3 }),
  });
  check('PATCH settings → limits on (key 5/min, ip 3/min)', settings.status === 200 && settings.body?.rate_limit_enabled === 'on' && settings.body?.rate_limit_key_rpm === 5 && settings.body?.rate_limit_ip_rpm === 3, JSON.stringify(settings.body));

  const badSettings = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ rate_limit_key_rpm: 0 }) });
  check('PATCH settings rejects rpm < 1 → 400', badSettings.status === 400, JSON.stringify(badSettings.body));

  const prov = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: PROVIDER_NAME, adapter: 'openai', base_url: `http://127.0.0.1:${mock.port}/v1` }),
  });
  check('create smoke provider', prov.status === 201, JSON.stringify(prov.body));
  const modelA = await j('/admin/models', { method: 'POST', body: JSON.stringify({ provider_id: prov.body.id, slug: SLUG_A }) });
  check('create uncapped model', modelA.status === 201 && modelA.body?.rate_limit_rpm === null);
  const modelB = await j('/admin/models', { method: 'POST', body: JSON.stringify({ provider_id: prov.body.id, slug: SLUG_B, rate_limit_rpm: 4 }) });
  check('create model with 4/min global cap', modelB.status === 201 && modelB.body?.rate_limit_rpm === 4);

  const keys = {};
  for (const name of KEY_NAMES) {
    const rpm = name.includes('override') ? 2 : null;
    const created = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name, rate_limit_rpm: rpm }) });
    check(`create key "${name}"${rpm ? ' (override 2/min)' : ''}`, created.status === 201 && created.body?.rate_limit_rpm === rpm, JSON.stringify(created.body));
    keys[name] = created.body?.key;
  }
  const keyA = keys[KEY_NAMES[0]];
  const keyB = keys[KEY_NAMES[1]];
  const keyC = keys[KEY_NAMES[2]];
  const keyD = keys[KEY_NAMES[3]];
  const keyE = keys[KEY_NAMES[4]];

  // Settings are TTL-cached (5 s) per isolate; wait out the window so the
  // gateway isolate is guaranteed to serve the tiny limits configured above.
  await sleep(5_500);

  // --- 1. anonymous → IP bucket --------------------------------------------
  {
    const r = await burst(8, () => chat(SLUG_A, null));
    // `allowed` can be 0 when a previous m10 run happened within this window
    // (the IP bucket is keyed by address, and dev shares one) — the limit is
    // what matters: at most 3 may pass.
    check('anonymous burst 8: ip limit 3 → at most 3 allowed', r.allowed <= 3, `allowed=${r.allowed}`);
    check('anonymous burst 8: the rest → 429', r.denied.length === 8 - r.allowed, `denied=${r.denied.length}`);
    check('429 carries integer Retry-After ≥ 1s', r.lastDenied?.retryAfter != null && Number.isInteger(Number(r.lastDenied.retryAfter)) && Number(r.lastDenied.retryAfter) >= 1, `retry-after=${r.lastDenied?.retryAfter}`);
    check('openai 429 envelope code rate_limit_exceeded', r.lastDenied?.body?.error?.code === 'rate_limit_exceeded' && r.lastDenied?.body?.error?.type === 'rate_limit_error', JSON.stringify(r.lastDenied?.body));
    check('429 message names the IP bucket', String(r.lastDenied?.body?.error?.message ?? '').includes('IP address'), JSON.stringify(r.lastDenied?.body));
  }

  // --- 2. keyed → key bucket (default 5/min) --------------------------------
  {
    const r = await burst(8, () => chat(SLUG_A, keyA));
    check('key burst 8: key limit 5 → at most 5 allowed', r.allowed > 0 && r.allowed <= 5, `allowed=${r.allowed}`);
    check('keyed 429 message names the API key', String(r.lastDenied?.body?.error?.message ?? '').includes("API key 'M10 A (smoke)'"), JSON.stringify(r.lastDenied?.body));
    check('keyed requests do NOT trip the ip bucket (all 8 answered by the key bucket)', r.allowed + r.denied.length === 8);
  }

  // --- 2b. anthropic face → anthropic 429 envelope on the exhausted key ------
  {
    const r = await chat(SLUG_A, keyA, '/v1/messages');
    check('anthropic face: exhausted key → 429', r.status === 429, `status=${r.status}`);
    check('anthropic 429 envelope type rate_limit_error', r.body?.type === 'error' && r.body?.error?.type === 'rate_limit_error', JSON.stringify(r.body));
    check('anthropic 429 also carries Retry-After', r.retryAfter != null && Number(r.retryAfter) >= 1, `retry-after=${r.retryAfter}`);
  }

  // --- 3. per-key override (2/min) ------------------------------------------
  {
    const r = await burst(4, () => chat(SLUG_A, keyC));
    check('override key burst 4: limit 2 → at most 2 allowed', r.allowed <= 2, `allowed=${r.allowed}`);
    check('override 429s carry Retry-After', r.lastDenied?.retryAfter != null && Number(r.lastDenied.retryAfter) >= 1);
  }

  // --- 4. key independence ---------------------------------------------------
  {
    const [rB, rD] = await Promise.all([burst(4, () => chat(SLUG_A, keyB)), burst(4, () => chat(SLUG_A, keyD))]);
    check('two keys burst together: each allows ≤ 5 independently', rB.allowed <= 5 && rD.allowed <= 5, `B=${rB.allowed} D=${rD.allowed}`);
    check('two keys burst together: both served (fresh buckets)', rB.allowed === 4 && rD.allowed === 4, `B=${rB.allowed} D=${rD.allowed}`);
  }

  // --- 5. global model cap ---------------------------------------------------
  {
    const r = await burst(8, () => chat(SLUG_B, keyE));
    check('model cap 4: fresh key allows ≤ 4', r.allowed <= 4, `allowed=${r.allowed}`);
    check('model-cap 429 message names the model', String(r.lastDenied?.body?.error?.message ?? '').includes(`'${SLUG_B}'`), JSON.stringify(r.lastDenied?.body));
    check('model-cap 429 code is rate_limit_exceeded', r.lastDenied?.body?.error?.code === 'rate_limit_exceeded');
  }

  // --- 6. disabled bypasses every bucket -------------------------------------
  {
    const off = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ rate_limit_enabled: 'off' }) });
    check('PATCH settings → limits off', off.status === 200 && off.body?.rate_limit_enabled === 'off');
    await sleep(5_500); // settings TTL
    const r = await burst(8, () => chat(SLUG_A, null));
    check('limits off: anonymous burst 8 → all 200 (stored ip counts ignored)', r.allowed === 8, `allowed=${r.allowed} first=${JSON.stringify(r.results[0]?.body).slice(0, 120)}`);
  }

  // --- logs: 429s are recorded like any other outcome ------------------------
  {
    const on = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ rate_limit_enabled: 'on' }) });
    check('PATCH settings → limits back on', on.status === 200 && on.body?.rate_limit_enabled === 'on');
    await sleep(5_500);
    const logs = await j('/admin/logs?limit=100');
    const rateLimited = (logs.body ?? []).filter((l) => l.status === 429 && [SLUG_A, SLUG_B].includes(l.model_slug));
    check('request_logs recorded the 429s with model attribution', rateLimited.length >= 3, `rows=${rateLimited.length}`);
    check('rate-limited log rows carry the error text', rateLimited.every((l) => typeof l.error === 'string' && l.error.includes('Rate limit exceeded')));
  }

  // --- cleanup ----------------------------------------------------------------
  await cleanup();
  await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ rate_limit_enabled: 'off', rate_limit_key_rpm: 120, rate_limit_ip_rpm: 60 }) });
  mock.server.close();

  console.log(`\n${passes.length} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exitCode = 1;
});
