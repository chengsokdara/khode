// M14 smoke test: playground UI backend — against `wrangler dev` on :8787
// (needs `npm run dev` running first).
//
// Exercises the M14 done-when: the playground can round-trip a streamed chat
// against any enabled model using its session-scoped key.
//   1. POST /admin/playground/key mints a session-scoped client key (401
//      without an admin session); the raw key rides only in the mint response
//   2. playground keys are hidden from GET /admin/api-keys (session-derived)
//   3. the key works at the gateway like any enrolled key: /v1/models +
//      a streamed /v1/chat/completions with usage, logged with exact cost
//   4. re-mint rotates (old key dies) and the new key satisfies
//      client_key_enforcement 'on'
//   5. logout deletes the session's playground key (401 under enforcement)
// Settings are TTL-cached (5 s) — enforcement toggles settle before asserting.
// Fixtures are named `… (smoke)` and self-cleaned; logs cleared at start +
// cleanup. Run only on dev DBs.
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

const login = async () => {
  const res = await j('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) });
  if (res.status !== 200) throw new Error('admin login failed — is .dev.vars in sync?');
};

// ------------------------------------------------------------ mock upstream

const STREAM_PIECES = ['Hello', ' from', ' the', ' playground!'];

function startMockUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'pg-chat', object: 'model' }] }));
      }
      if (url.endsWith('/chat/completions')) {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) || {};
        } catch {
          body = {};
        }
        const usage = { prompt_tokens: 7, completion_tokens: 5 };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const piece of STREAM_PIECES) {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-pg', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-pg', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'chatcmpl-pg',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
            usage,
          }),
        );
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- fixtures

const PROVIDER_NAME = 'Playground Mock (smoke)';
const MODEL_SLUG = 'pg-chat';
let pgKey1 = null; // { id, key } — first mint (revoked by rotation)
let pgKey2 = null; // second mint (revoked by logout)

async function cleanup() {
  const providers = await j('/admin/providers');
  for (const p of providers.body ?? []) {
    if (p.name === PROVIDER_NAME) await j(`/admin/providers/${p.id}`, { method: 'DELETE' });
  }
  const models = await j('/admin/models');
  for (const m of models.body ?? []) {
    if (m.slug === MODEL_SLUG) await j(`/admin/models/${m.id}`, { method: 'DELETE' });
  }
  await j('/admin/logs', { method: 'DELETE' });
}

// ------------------------------------------------------------------- run

const server = await startMockUpstream();
const mockPort = server.address().port;

try {
  await login();
  await cleanup();

  // Fixtures: one enabled model with exact pricing so the log cost is assertable.
  const prov = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: PROVIDER_NAME, adapters: ['openai'], base_url: `http://127.0.0.1:${mockPort}/v1` }),
  });
  check('setup: provider created', prov.status === 201, `status ${prov.status}`);
  const model = await j('/admin/models', {
    method: 'POST',
    body: JSON.stringify({ provider_id: prov.body.id, slug: MODEL_SLUG, pricing_input: 2, pricing_output: 8 }),
  });
  check('setup: model created', model.status === 201, `status ${model.status}`);

  // --- mint: auth required -------------------------------------------------
  const savedCookie = cookie;
  cookie = '';
  const unauth = await j('/admin/playground/key', { method: 'POST' });
  check('mint without session → 401', unauth.status === 401, `status ${unauth.status}`);
  cookie = savedCookie;

  // --- mint: session-scoped key -------------------------------------------
  const mint1 = await j('/admin/playground/key', { method: 'POST' });
  check('mint returns 201', mint1.status === 201, `status ${mint1.status}`);
  pgKey1 = mint1.body ?? {};
  check('minted key material is a khat- key', typeof pgKey1.key === 'string' && pgKey1.key.startsWith('khat-'));
  check('minted key has an id + prefix', typeof pgKey1.id === 'string' && pgKey1.key_prefix === pgKey1.key.slice(0, 9));

  const keyList = await j('/admin/api-keys');
  check('playground key hidden from /admin/api-keys', !(keyList.body ?? []).some((k) => k.id === pgKey1.id));

  // --- the key works at the gateway ---------------------------------------
  const v1models = await j('/v1/models', { headers: { authorization: `Bearer ${pgKey1.key}` } });
  check('GET /v1/models with playground key', v1models.status === 200 && (v1models.body?.data ?? []).some((m) => m.id === MODEL_SLUG));

  const startedAt = Date.now();
  const streamRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pgKey1.key}` },
    body: JSON.stringify({ model: MODEL_SLUG, messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true } }),
  });
  check('streamed call → text/event-stream', streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'));
  check('attempts header spans the chain', streamRes.headers.get('x-khateway-attempts') === '1');

  const text = await streamRes.text();
  const deltas = [];
  let sawDone = false;
  let usageChunk = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const data = t.slice(5).trim();
    if (data === '[DONE]') {
      sawDone = true;
      continue;
    }
    try {
      const chunk = JSON.parse(data);
      const piece = chunk.choices?.[0]?.delta?.content;
      if (piece) deltas.push(piece);
      if (chunk.usage) usageChunk = chunk.usage;
    } catch {
      // ignore
    }
  }
  check('stream assembled text', deltas.join('') === STREAM_PIECES.join(''), `got "${deltas.join('')}"`);
  check('stream ends with [DONE]', sawDone);
  check('usage rides the stream (7 in / 5 out)', usageChunk?.prompt_tokens === 7 && usageChunk?.completion_tokens === 5, JSON.stringify(usageChunk));

  // The resulting log row (usage lands after the stream — poll briefly).
  let logRow = null;
  for (let i = 0; i < 10 && !logRow; i++) {
    const logs = await j(`/admin/logs?api_key_id=${pgKey1.id}&limit=5`);
    logRow = (logs.body ?? []).find((r) => r.created_at >= startedAt - 1500) ?? null;
    if (!logRow) await sleep(500);
  }
  check('log row appears for the playground key', !!logRow);
  if (logRow) {
    check('log row: status 200, dialect chat, model', logRow.status === 200 && logRow.dialect === 'chat' && logRow.model_slug === MODEL_SLUG);
    check('log row: usage 7 in / 5 out', logRow.tokens_in === 7 && logRow.tokens_out === 5);
    check('log row: exact cost at $2/$8 per 1M', Math.round((logRow.cost_usd ?? 0) * 1e6) === 54, `cost_usd ${logRow.cost_usd}`);
    check('log row: attributed to the Playground key', logRow.key_name === 'Playground' && logRow.api_key_id === pgKey1.id);
  }

  // --- rotation + enforcement ----------------------------------------------
  const mint2 = await j('/admin/playground/key', { method: 'POST' });
  pgKey2 = mint2.body ?? {};
  check('re-mint rotates to a new key', mint2.status === 201 && pgKey2.id !== pgKey1.id && pgKey2.key !== pgKey1.key);

  await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ client_key_enforcement: 'on' }) });
  await sleep(5200); // settings snapshot TTL

  const oldAfterRotate = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pgKey1.key}` },
    body: JSON.stringify({ model: MODEL_SLUG, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  check('rotated-out key → 401 under enforcement', oldAfterRotate.status === 401, `status ${oldAfterRotate.status}`);

  const newUnderEnforcement = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pgKey2.key}` },
    body: JSON.stringify({ model: MODEL_SLUG, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  check('current playground key satisfies enforcement', newUnderEnforcement.status === 200, `status ${newUnderEnforcement.status}`);

  // --- logout kills the session's key --------------------------------------
  await j('/admin/logout', { method: 'POST' });
  const oldAfterLogout = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pgKey2.key}` },
    body: JSON.stringify({ model: MODEL_SLUG, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  check('logout revoked the session playground key', oldAfterLogout.status === 401, `status ${oldAfterLogout.status}`);

  await login(); // fresh session (old cookie died with the logout)
  await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ client_key_enforcement: 'off' }) });
  await sleep(5200);
  const mint3 = await j('/admin/playground/key', { method: 'POST' });
  check('new session mints a working key again', mint3.status === 201 && typeof mint3.body?.key === 'string');
  const freshCall = await j('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${mint3.body.key}` },
    body: JSON.stringify({ model: MODEL_SLUG, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  check('fresh session key calls the gateway (enforcement off)', freshCall.status === 200, `status ${freshCall.status}`);
} catch (e) {
  fail('smoke aborted', e?.message ?? String(e));
} finally {
  await cleanup();
  server.close();
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
