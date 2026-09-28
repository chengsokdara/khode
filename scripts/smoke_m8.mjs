// M8 smoke test: portal accounts + prepaid balance + Lemon Squeezy webhook —
// against `wrangler dev` on :8787 (needs `npm run dev` running first).
//
// Exercises the M8 done-when: signup → credit → key works until balance
// exhausted, webhook credit signature-verified + idempotent. Uses a local mock
// upstream (openai non-stream + stream, usage 3 in / 5 out, model priced
// $2/$8 per 1M → exactly $0.000046 = 46 micros per request) so balance debits
// are assertable. The real LS checkout API is NOT exercised (no credentials
// here); the webhook path — signature, credit, idempotency — is, via signed
// requests computed locally.
//
// Fixtures are named `… (smoke)` / `m8-…@example.com` and self-cleaned
// (provider, models, user + their keys/ledger). webhook_events rows are kept
// (audit trail, order ids are per-run random). Run only on dev DBs.
import http from 'node:http';
import crypto from 'node:crypto';

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
async function waitFor(fn, timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  return null;
}

// ------------------------------------------------------------- cookies + api

const jar = { admin: '', portal: '' };
function cookieHeader() {
  return [jar.admin, jar.portal].filter(Boolean).join('; ');
}
function captureCookie(setCookieValue, name) {
  if (setCookieValue && setCookieValue.includes(`${name}=`) && !setCookieValue.includes('Max-Age=0')) {
    return `${name}=${setCookieValue.split(`${name}=`)[1].split(';')[0]}`;
  }
  return null;
}
const api = async (path, opts = {}, as = 'admin') => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookieHeader() ? { cookie: cookieHeader() } : {}), ...(opts.headers || {}) },
  });
  for (const [name, key] of [['khateway_session', 'admin'], ['khateway_user', 'portal']]) {
    const captured = captureCookie(res.headers.get('set-cookie'), name);
    if (captured && (as === key || key === 'portal')) jar[key] = captured;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body };
};

// ------------------------------------------------------------ mock upstream

let upstreamPort = 0;
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
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm8-chat-smoke', object: 'model' }] }));
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish, usage) => {
          const payload = { id: 'chatcmpl-m8', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] };
          if (usage) payload.usage = usage;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        chunk({ role: 'assistant', content: 'Hello from the mock upstream!' }, null);
        chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-m8',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the mock upstream!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ------------------------------------------------------------------- fixtures

const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL = `m8-smoke-${RUN}@example.com`;
const EMAIL2 = `m8-smoke-2-${RUN}@example.com`;
const PASSWORD = 'smoke-password-1';
const PROVIDER_NAME = 'Khateway M8 Mock (smoke)';
const SLUG = 'm8-chat-smoke';
const KEY_NAME = 'M8 Key (smoke)';
/** 3 in @ $2/1M + 5 out @ $8/1M = $0.000046 per request. */
const DEBIT_MICROS_PER_CALL = 46;
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

async function cleanup({ restoreSignup }) {
  const provs = await api('/api/admin/providers');
  for (const p of provs.body ?? []) if (p.name === PROVIDER_NAME) await api(`/api/admin/providers/${p.id}`, { method: 'DELETE' });
  const keys = await api('/api/admin/api-keys');
  for (const k of keys.body ?? []) if (k.name === KEY_NAME && !k.user_id) await api(`/api/admin/api-keys/${k.id}`, { method: 'DELETE' });
  const users = await api('/api/admin/users');
  for (const u of users.body ?? []) if (u.email.startsWith('m8-smoke-') && u.email.endsWith(`-${RUN}@example.com`)) await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
  if (restoreSignup !== undefined) await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ public_signup: restoreSignup }) });
  await api('/api/admin/billing/config', { method: 'PATCH', body: JSON.stringify({ store_id: null, variant_id: null, api_key: null, webhook_secret: null }) });
}

// ----------------------------------------------------------------- the suite

(async () => {
  console.log('health:', (await api('/health')).status);

  const login = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) });
  check('admin login', login.status === 200);

  // M10 rate limiting is on by default — keep this suite's bursts unthrottled
  // (smoke_m10.mjs exercises the limiter itself).
  const rlOff = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ rate_limit_enabled: 'off' }) });
  check('rate limiting disabled for burst safety (M10)', rlOff.status === 200 && rlOff.body?.rate_limit_enabled === 'off');

  const settings0 = await api('/api/admin/settings');
  await cleanup({ restoreSignup: settings0.body?.public_signup ?? 'on' });

  // --- signup validation ----------------------------------------------------
  const badEmail = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: 'not-an-email', password: PASSWORD }) }, 'portal');
  check('signup: invalid email → 400', badEmail.status === 400);
  const shortPw = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: 'short' }) }, 'portal');
  check('signup: short password → 400', shortPw.status === 400);

  // keyless-native regression: anonymous gateway still served (before any account work)
  const { port } = await startMockUpstream();
  upstreamPort = port;
  const prov = await api('/api/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: PROVIDER_NAME, adapter: 'openai', base_url: `http://127.0.0.1:${upstreamPort}/v1` }),
  });
  check('create smoke provider', prov.status === 201);
  const model = await api('/api/admin/models', {
    method: 'POST',
    body: JSON.stringify({ provider_id: prov.body.id, slug: SLUG, pricing_input: 2, pricing_output: 8 }),
  });
  check('create smoke model (priced $2/$8 per 1M)', model.status === 201);

  const anon = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: SLUG, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('strict auth: anonymous /v1 call → 401 (no keyless)', anon.status === 401);
  await anon.text();

  // --- signup + session -----------------------------------------------------
  const signup = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }, 'portal');
  check('signup → 201 + session cookie', signup.status === 201 && jar.portal.includes('khateway_user=') && signup.body?.user?.email === EMAIL);
  check('new user balance is 0', signup.body?.user?.balance_usd === 0);
  const me0 = await api('/api/portal/me', {}, 'portal');
  check('me: authenticated, billing unconfigured', me0.status === 200 && me0.body?.user?.email === EMAIL && me0.body?.billing_configured === false);

  const dup = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }, 'portal');
  check('duplicate signup → 409', dup.status === 409, `got ${dup.status} ${JSON.stringify(dup.body)}`);

  const badLogin = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: 'wrong-password' }) }, 'portal');
  check('login: wrong password → 401', badLogin.status === 401);
  const noUser = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: `ghost-${RUN}@example.com`, password: PASSWORD }) }, 'portal');
  check('login: unknown email → same 401 (no oracle)', noUser.status === 401 && noUser.body?.error === badLogin.body?.error);

  // public_signup off closes the door
  await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ public_signup: 'off' }) });
  const closed = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: EMAIL2, password: PASSWORD }) }, 'portal');
  check('public_signup off → signup 403', closed.status === 403, `got ${closed.status} ${JSON.stringify(closed.body)}`);
  await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ public_signup: 'on' }) });

  // --- password reset: self-service change + admin reset ----------------------
  const PASSWORD2 = 'reset-pass-9876';
  const wrongCurrent = await api('/api/portal/me/password', { method: 'POST', body: JSON.stringify({ current_password: 'not-my-password', new_password: PASSWORD2 }) }, 'portal');
  check('self-service change: wrong current password → 400', wrongCurrent.status === 400, JSON.stringify(wrongCurrent.body));
  const shortNext = await api('/api/portal/me/password', { method: 'POST', body: JSON.stringify({ current_password: PASSWORD, new_password: 'short' }) }, 'portal');
  check('self-service change: short new password → 400', shortNext.status === 400);
  const changed = await api('/api/portal/me/password', { method: 'POST', body: JSON.stringify({ current_password: PASSWORD, new_password: PASSWORD2 }) }, 'portal');
  check('self-service change with right current → 200', changed.status === 200, JSON.stringify(changed.body));
  const oldLogin = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }, 'portal');
  check('login with OLD password after change → 401', oldLogin.status === 401);
  const newLogin = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD2 }) }, 'portal');
  check('login with NEW password → 200', newLogin.status === 200 && newLogin.body?.user?.email === EMAIL);
  const mePw = await api('/api/portal/me', {}, 'portal');
  check('me: has_password true for password account', mePw.body?.user?.has_password === true, JSON.stringify(mePw.body?.user));

  // Admin reset back to the original password — and it must revoke the live
  // session minted BEFORE the reset (the current jar cookie).
  const adminUser = (await api('/api/admin/users')).body.find((u) => u.email === EMAIL);
  const shortAdminReset = await api(`/api/admin/users/${adminUser.id}/password`, { method: 'POST', body: JSON.stringify({ password: 'short' }) }, 'admin');
  check('admin reset: short password → 400', shortAdminReset.status === 400);
  const adminReset = await api(`/api/admin/users/${adminUser.id}/password`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) }, 'admin');
  check('admin reset → 200', adminReset.status === 200 && adminReset.body?.ok === true, JSON.stringify(adminReset.body));
  const preResetSession = await api('/api/portal/me', {}, 'portal');
  check('admin reset revokes pre-reset sessions → 401', preResetSession.status === 401, `got ${preResetSession.status}`);
  const resetLogin = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }, 'portal');
  check('login with admin-reset password → 200 (jar refreshed)', resetLogin.status === 200);

  // --- user key + balance gate ----------------------------------------------
  const keyRes = await api('/api/portal/keys', { method: 'POST', body: JSON.stringify({ name: KEY_NAME }) }, 'portal');
  const rawKey = keyRes.body?.key ?? '';
  check('portal key created, raw shown once', keyRes.status === 201 && rawKey.startsWith('khat-') && keyRes.body?.key_prefix?.length === 9);
  const keyId = keyRes.body?.id;

  const gw = async (rawKeyOverride, body) => {
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(rawKeyOverride ? { authorization: `Bearer ${rawKeyOverride}` } : {}) },
      body: JSON.stringify(body ?? { model: SLUG, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  const broke = await gw(rawKey);
  check('balance 0 → gateway 429 insufficient_quota', broke.status === 429 && broke.body?.error?.code === 'insufficient_quota', JSON.stringify(broke.body?.error));
  const adminGw = await gw('');
  check('strict auth: no-key call → 401 (no keyless)', adminGw.status === 401);

  const credit = await api(`/api/admin/users`);
  const user0 = (credit.body ?? []).find((u) => u.email === EMAIL);
  await api(`/api/admin/users/${user0.id}`, { method: 'PATCH', body: JSON.stringify({ balance_adjust_usd: 5, note: 'smoke grant' }) });
  const bal5 = await waitFor(async () => (await api('/api/portal/me', {}, 'portal')).body?.user);
  check('admin +$5 grant → balance 5', bal5?.balance_usd === 5, JSON.stringify(bal5));

  // --- usage debits ----------------------------------------------------------
  const ok1 = await gw(rawKey);
  check('funded account → gateway 200', ok1.status === 200 && ok1.body?.usage?.total_tokens === 8);
  const after1 = await waitFor(async () => {
    const me = await api('/api/portal/me', {}, 'portal');
    return me.body?.user?.balance_usd != null && Math.abs(me.body.user.balance_usd - (5 - DEBIT_MICROS_PER_CALL / 1e6)) < 1e-9 ? me.body.user.balance_usd : null;
  });
  check(`non-stream debit = ${DEBIT_MICROS_PER_CALL} micros`, after1 != null, String(after1));

  const streamRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ model: SLUG, messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check('streamed call → 200 SSE', streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'));
  await streamRes.text();
  const after2 = await waitFor(async () => {
    const me = await api('/api/portal/me', {}, 'portal');
    const want = 5 - (2 * DEBIT_MICROS_PER_CALL) / 1e6;
    return me.body?.user?.balance_usd != null && Math.abs(me.body.user.balance_usd - want) < 1e-9 ? me.body.user.balance_usd : null;
  });
  check('streamed debit lands after the stream (tee watcher)', after2 != null, String(after2));

  // --- M16: client /api/v1 key + credit endpoints -----------------------------
  {
    const k = await fetch(base + '/api/v1/auth/key', { headers: { authorization: `Bearer ${rawKey}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    check(
      'M16 /api/v1/auth/key (user key) → accrued usage',
      k.status === 200 && k.body?.data?.label === KEY_NAME && Math.abs(k.body.data.usage - (2 * DEBIT_MICROS_PER_CALL) / 1e6) < 1e-9,
      JSON.stringify(k.body),
    );
    const cr = await fetch(base + '/api/v1/credits', { headers: { authorization: `Bearer ${rawKey}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const want = 5 - (2 * DEBIT_MICROS_PER_CALL) / 1e6;
    check(
      'M16 /api/v1/credits (user key) → balance + account-wide usage',
      cr.status === 200 && cr.body?.data?.scope === 'user' && Math.abs(cr.body.data.total_credits - want) < 1e-9 && Math.abs(cr.body.data.total_usage - (2 * DEBIT_MICROS_PER_CALL) / 1e6) < 1e-9,
      JSON.stringify(cr.body),
    );
  }

  const ledger = await api('/api/portal/billing', {}, 'portal');
  const usageEntries = (ledger.body?.entries ?? []).filter((e) => e.kind === 'usage');
  check(
    'ledger records usage debits',
    usageEntries.length >= 2 && usageEntries.every((e) => Math.abs(e.delta_usd + DEBIT_MICROS_PER_CALL / 1e6) < 1e-9),
    JSON.stringify(usageEntries.slice(0, 2)),
  );

  // drain to zero → 429 again
  const meNow = await api('/api/portal/me', {}, 'portal');
  const drainTo = -meNow.body.user.balance_usd - 0.01; // push slightly below zero
  await api(`/api/admin/users/${user0.id}`, { method: 'PATCH', body: JSON.stringify({ balance_adjust_usd: drainTo }) });
  const drained = await gw(rawKey);
  check('exhausted balance → 429 again', drained.status === 429 && drained.body?.error?.code === 'insufficient_quota');

  // --- lemon squeezy webhook --------------------------------------------------
  const cfg = await api('/api/admin/billing/config', {
    method: 'PATCH',
    body: JSON.stringify({ store_id: `smoke-store-${RUN}`, variant_id: `smoke-variant-${RUN}`, api_key: 'sk_ls_smoke', webhook_secret: 'whsec_smoke' }),
  });
  check('billing config saved (hints only)', cfg.status === 200 && cfg.body?.api_key_hint === 'moke' && cfg.body?.webhook_secret_set === true);
  const meCfg = await api('/api/portal/me', {}, 'portal');
  check('portal sees billing configured', meCfg.body?.billing_configured === true);

  const webhook = async (payloadObj, sig) => {
    const raw = JSON.stringify(payloadObj);
    const res = await fetch(base + '/webhooks/lemonsqueezy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig } : {}) },
      body: raw,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };
  const order = (orderId, extraAttrs = {}) => ({
    meta: { event_name: 'order_created', custom_data: { user_id: user0.id } },
    data: {
      type: 'orders',
      id: orderId,
      attributes: { store_id: 1, currency: 'USD', subtotal: 1000, discount_total: 0, tax: 0, total: 1000, status: 'paid', refunded: false, ...extraAttrs },
    },
  });

  const noSig = await webhook(order(`ord-${RUN}-a`), undefined);
  check('webhook without signature → 401', noSig.status === 401);
  const badSig = await webhook(order(`ord-${RUN}-a`), 'deadbeef');
  check('webhook with bad signature → 401', badSig.status === 401);

  const balanceOf = async () => (await api('/api/portal/me', {}, 'portal')).body?.user?.balance_usd;
  const beforeTopup = await balanceOf();

  const topup = await webhook(order(`ord-${RUN}-1`), sign('whsec_smoke', JSON.stringify(order(`ord-${RUN}-1`))));
  const afterTopup = await waitFor(async () => {
    const b = await balanceOf();
    return b != null && Math.abs(b - (beforeTopup + 10)) < 1e-9 ? b : null;
  });
  check('signed order_created $10 → credited', topup.status === 200 && topup.body?.credited_usd === 10 && afterTopup != null, JSON.stringify(topup.body));

  const replay = await webhook(order(`ord-${RUN}-1`), sign('whsec_smoke', JSON.stringify(order(`ord-${RUN}-1`))));
  const afterReplay = await balanceOf();
  check('replayed webhook → duplicate, no double credit', replay.status === 200 && replay.body?.duplicate === true && afterReplay === afterTopup);

  const refunded = await webhook(
    { meta: { event_name: 'order_refunded', custom_data: { user_id: user0.id } }, data: { type: 'orders', id: `ord-${RUN}-2`, attributes: { status: 'paid', refunded: true, total: 1000 } } },
    sign('whsec_smoke', JSON.stringify({ meta: { event_name: 'order_refunded', custom_data: { user_id: user0.id } }, data: { type: 'orders', id: `ord-${RUN}-2`, attributes: { status: 'paid', refunded: true, total: 1000 } } })),
  );
  check('order_refunded recorded, not credited', refunded.status === 200 && refunded.body?.ok === true && !refunded.body?.credited_usd);

  const ghostOrder = order(`ord-${RUN}-3`);
  ghostOrder.meta.custom_data.user_id = 'no-such-user';
  const unknownUser = await webhook(ghostOrder, sign('whsec_smoke', JSON.stringify(ghostOrder)));
  check('webhook for unknown user → ok + ignored (no retry loop)', unknownUser.status === 200 && unknownUser.body?.ok === true && !unknownUser.body?.credited_usd);

  // account works again after top-up
  const revived = await gw(rawKey);
  check('post-topup gateway call → 200', revived.status === 200);

  // --- key scoping + checkout API --------------------------------------------
  const adminKey = await api('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Admin Only (smoke)' }) });
  const portalKeys = await api('/api/portal/keys', {}, 'portal');
  check('portal sees only own keys (admin key invisible)', portalKeys.status === 200 && portalKeys.body?.some((k) => k.id === keyId) && !portalKeys.body?.some((k) => k.id === adminKey.body?.id));
  const adminList = await api('/api/admin/api-keys');
  const mine = adminList.body?.find((k) => k.id === keyId);
  check('admin key list shows user attribution', mine?.user_id === user0.id && mine?.user_email === EMAIL);
  await api(`/api/admin/api-keys/${adminKey.body?.id}`, { method: 'DELETE' });

  const patchKey = await api(`/api/portal/keys/${keyId}`, { method: 'PATCH', body: JSON.stringify({ name: 'M8 Key renamed (smoke)' }) }, 'portal');
  check('portal key rename', patchKey.status === 200 && patchKey.body?.name === 'M8 Key renamed (smoke)');

  const co = await api('/api/portal/billing/checkout', { method: 'POST', body: JSON.stringify({ amount_usd: 10 }) }, 'portal');
  check('checkout with fake LS creds → 502 upstream error surfaced', co.status === 502 && typeof co.body?.error === 'string');
  const coBad = await api('/api/portal/billing/checkout', { method: 'POST', body: JSON.stringify({ amount_usd: 10000 }) }, 'portal');
  check('checkout amount out of bounds → 400', coBad.status === 400);

  // --- logout / revocation -----------------------------------------------------
  const logout = await api('/api/portal/logout', { method: 'POST' }, 'portal');
  jar.portal = '';
  const meAfterLogout = await api('/api/portal/me', {}, 'portal');
  check('portal logout revokes session (me → 401)', logout.status === 200 && meAfterLogout.status === 401);
  const relogin = await api('/api/portal/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }, 'portal');
  check('portal login again → 200', relogin.status === 200, `got ${relogin.status} ${JSON.stringify(relogin.body)}`);

  // --- cleanup -----------------------------------------------------------------
  await cleanup({ restoreSignup: settings0.body?.public_signup ?? 'on' });
  const meDeleted = await api('/api/portal/me', {}, 'portal');
  check('cleanup: user deleted → session dead (401)', meDeleted.status === 401);
  const usersLeft = await api('/api/admin/users');
  check('cleanup: no smoke users left', !(usersLeft.body ?? []).some((u) => u.email.includes(RUN)));
  const provsLeft = await api('/api/admin/providers');
  check('cleanup: no smoke provider left', !(provsLeft.body ?? []).some((p) => p.name === PROVIDER_NAME));

  console.log('');
  if (failures === 0) {
    console.log(`SMOKE OK — ${passes.length} checks passed`);
    process.exit(0);
  } else {
    console.log(`SMOKE FAILED — ${failures} of ${failures + passes.length} checks failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
