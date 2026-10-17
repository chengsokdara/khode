// M9 smoke test: multi-user orgs / teams — against `wrangler dev` on :8787
// (needs `npm run dev` running first).
//
// Exercises the M9 done-when: two orgs coexist without seeing each other's
// keys/logs; users self-serve signup → create key → call gateway. Uses the
// same mock upstream shape as smoke_m8 (openai, usage 3 in / 5 out, model
// priced $2/$8 per 1M → exactly $0.000046 = 46 micros per request) so org
// balance debits are assertable. The real LS checkout API is NOT exercised;
// the ORG webhook credit path is (signed locally).
//
// Fixtures are named `M9 … (smoke)` / `m9-smoke-…-<run>@example.com` and
// self-cleaned (orgs first — removing memberships — then users, provider).
// Run only on dev DBs.
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
// Four portal sessions live at once (A owner, B member, C outsider, D joiner) —
// each portal user gets their own cookie slot; admin gets its own.

const jar = { admin: '', A: '', B: '', C: '', D: '' };
function cookieFor(as) {
  return as === 'admin' ? jar.admin : jar[as] ?? '';
}
function captureCookie(setCookieValue, name) {
  if (setCookieValue && setCookieValue.includes(`${name}=`) && !setCookieValue.includes('Max-Age=0')) {
    return `${name}=${setCookieValue.split(`${name}=`)[1].split(';')[0]}`;
  }
  return null;
}
const api = async (path, opts = {}, as = 'admin') => {
  const cookie = cookieFor(as);
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  const adminCookie = captureCookie(setCookie, 'khateway_session');
  if (adminCookie) jar.admin = adminCookie;
  if (as !== 'admin') {
    const userCookie = captureCookie(setCookie, 'khateway_user');
    if (userCookie) jar[as] = userCookie;
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
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm9-chat-smoke', object: 'model' }] }));
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish, usage) => {
          const payload = { id: 'chatcmpl-m9', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] };
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
          id: 'chatcmpl-m9',
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
/** Emails are stored lowercased (signup normalizes) — keep the handle lowercase. */
const email = (who) => `m9-smoke-${who.toLowerCase()}-${RUN}@example.com`;
const PASSWORD = 'smoke-password-1';
const PROVIDER_NAME = 'Khateway M9 Mock (smoke)';
const SLUG = 'm9-chat-smoke';
const ALPHA = 'M9 Alpha (smoke)';
const BETA = 'M9 Beta (smoke)';
const GAMMA = 'M9 Gamma (smoke)';
/** 3 in @ $2/1M + 5 out @ $8/1M = $0.000046 per request. */
const DEBIT_MICROS_PER_CALL = 46;
const DEBIT_USD = DEBIT_MICROS_PER_CALL / 1e6;
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

let ids = {}; // email → user id, org name → org id, key name → key id

async function cleanup({ restoreSignup }) {
  const orgsList = await api('/api/admin/orgs');
  for (const o of orgsList.body ?? []) if (o.name?.includes('(smoke)') && o.name?.startsWith('M9 ')) await api(`/api/admin/orgs/${o.id}`, { method: 'DELETE' });
  const provs = await api('/api/admin/providers');
  for (const p of provs.body ?? []) if (p.name === PROVIDER_NAME) await api(`/api/admin/providers/${p.id}`, { method: 'DELETE' });
  const users = await api('/api/admin/users');
  for (const u of users.body ?? []) if (u.email.startsWith('m9-smoke-') && u.email.endsWith(`-${RUN}@example.com`)) await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
  if (restoreSignup !== undefined) await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ public_signup: restoreSignup }) });
  await api('/api/admin/billing/config', { method: 'PATCH', body: JSON.stringify({ store_id: null, variant_id: null, api_key: null, webhook_secret: null }) });
}

async function signup(who) {
  const res = await api('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: email(who), password: PASSWORD }) }, who);
  check(`signup ${who} → 201`, res.status === 201, `got ${res.status}`);
  const list = await api('/api/admin/users');
  ids[`user:${who}`] = (list.body ?? []).find((u) => u.email === email(who))?.id;
  return res;
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

  // --- accounts + orgs -------------------------------------------------------
  await signup('A');
  await signup('B');
  await signup('C');
  await signup('D');

  const alphaRes = await api('/api/portal/orgs', { method: 'POST', body: JSON.stringify({ name: ALPHA }) }, 'A');
  check('A creates Alpha → 201 owner', alphaRes.status === 201 && alphaRes.body?.role === 'owner' && alphaRes.body?.balance_usd === 0);
  ids.orgAlpha = alphaRes.body?.id;
  const myOrgsA = await api('/api/portal/orgs', {}, 'A');
  check('A org list shows Alpha', myOrgsA.body?.some((o) => o.id === ids.orgAlpha && o.member_count === 1));

  const betaRes = await api('/api/portal/orgs', { method: 'POST', body: JSON.stringify({ name: BETA }) }, 'B');
  check('B creates Beta → two orgs coexist', betaRes.status === 201 && betaRes.body?.id !== ids.orgAlpha);
  ids.orgBeta = betaRes.body?.id;

  const badCode = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: 'not-a-code' }) }, 'C');
  check('join with bad code → 404', badCode.status === 404);

  const alphaAsA = await api(`/api/portal/orgs/${ids.orgAlpha}`, {}, 'A');
  check('owner sees join code + members', typeof alphaAsA.body?.join_code === 'string' && alphaAsA.body?.join_code.length === 10 && alphaAsA.body?.members?.length === 1);
  const code1 = alphaAsA.body?.join_code;

  const alphaAsC = await api(`/api/portal/orgs/${ids.orgAlpha}`, {}, 'C');
  check('outsider C sees Alpha as 404 (no leak)', alphaAsC.status === 404);
  const alphaAsB = await api(`/api/portal/orgs/${ids.orgAlpha}`, {}, 'B');
  check('non-member B sees Alpha as 404', alphaAsB.status === 404);

  const join = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: code1 }) }, 'B');
  check('B joins Alpha via code → member', join.status === 201 && join.body?.role === 'member');
  const join2 = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: code1 }) }, 'B');
  check('second join → 409 already member', join2.status === 409);

  // --- isolation: members see org surfaces, outsiders never ------------------
  for (const [label, path] of [
    ['detail', `/api/portal/orgs/${ids.orgAlpha}`],
    ['keys', `/api/portal/orgs/${ids.orgAlpha}/keys`],
    ['usage', `/api/portal/orgs/${ids.orgAlpha}/usage`],
    ['billing', `/api/portal/orgs/${ids.orgAlpha}/billing`],
  ]) {
    const r = await api(path, {}, 'C');
    check(`outsider C ${label} → 404`, r.status === 404, `got ${r.status}`);
  }

  // --- org keys + permission matrix ------------------------------------------
  const k1 = await api(`/api/portal/orgs/${ids.orgAlpha}/keys`, { method: 'POST', body: JSON.stringify({ name: 'M9 K1 (smoke)' }) }, 'A');
  check('A creates org key K1', k1.status === 201 && k1.body?.key?.startsWith('khat-') && k1.body?.created_by_email === email('A'));
  ids.keyK1 = k1.body?.id;
  const k2 = await api(`/api/portal/orgs/${ids.orgAlpha}/keys`, { method: 'POST', body: JSON.stringify({ name: 'M9 K2 (smoke)' }) }, 'B');
  check('B creates org key K2 (creator attribution B)', k2.status === 201 && k2.body?.created_by_email === email('B'));
  ids.keyK2 = k2.body?.id;

  const personalB = await api('/api/portal/keys', {}, 'B');
  check('personal key list excludes org keys', personalB.status === 200 && !personalB.body?.some((k) => k.id === ids.keyK2));
  const personalPatch = await api(`/api/portal/keys/${ids.keyK2}`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }, 'B');
  check('personal endpoint cannot touch org key → 404', personalPatch.status === 404);

  const bPatchK1 = await api(`/api/portal/orgs/${ids.orgAlpha}/keys/${ids.keyK1}`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }, 'B');
  check("member B cannot patch A's key → 404", bPatchK1.status === 404);
  const bPatchK2 = await api(`/api/portal/orgs/${ids.orgAlpha}/keys/${ids.keyK2}`, { method: 'PATCH', body: JSON.stringify({ name: 'M9 K2 renamed (smoke)' }) }, 'B');
  check('member B patches own key', bPatchK2.status === 200 && bPatchK2.body?.name === 'M9 K2 renamed (smoke)');
  const aPatchK2 = await api(`/api/portal/orgs/${ids.orgAlpha}/keys/${ids.keyK2}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }, 'A');
  check('owner A patches any org key', aPatchK2.status === 200 && aPatchK2.body?.enabled === false);
  await api(`/api/portal/orgs/${ids.orgAlpha}/keys/${ids.keyK2}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) }, 'A');

  // --- member restrictions + last-owner guards --------------------------------
  const bRename = await api(`/api/portal/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ name: 'Nope' }) }, 'B');
  check('member cannot rename org → 403', bRename.status === 403);
  const bRotate = await api(`/api/portal/orgs/${ids.orgAlpha}/regenerate-code`, { method: 'POST' }, 'B');
  check('member cannot rotate code → 403', bRotate.status === 403);
  const bCheckout = await api(`/api/portal/orgs/${ids.orgAlpha}/billing/checkout`, { method: 'POST', body: JSON.stringify({ amount_usd: 5 }) }, 'B');
  check('member cannot top up org → 403', bCheckout.status === 403);
  const bRole = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:A']}`, { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }, 'B');
  check('member cannot change roles → 403', bRole.status === 403);
  const bKick = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:A']}`, { method: 'DELETE' }, 'B');
  check('member cannot remove members → 403', bKick.status === 403);

  const selfDemote = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:A']}`, { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }, 'A');
  check('last owner cannot demote self → 400', selfDemote.status === 400);
  const selfRemove = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:A']}`, { method: 'DELETE' }, 'A');
  check('owner cannot remove self → 400', selfRemove.status === 400);

  const leaveOwner = await api(`/api/portal/orgs/${ids.orgAlpha}/leave`, { method: 'POST' }, 'A');
  check('owner cannot leave → 400', leaveOwner.status === 400);
  const leaveB = await api(`/api/portal/orgs/${ids.orgAlpha}/leave`, { method: 'POST' }, 'B');
  check('member B leaves Alpha', leaveB.status === 200);
  const alphaAfterLeave = await api(`/api/portal/orgs/${ids.orgAlpha}`, {}, 'B');
  check('left member loses access → 404', alphaAfterLeave.status === 404);
  const rejoin = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: code1 }) }, 'B');
  check('B rejoins Alpha', rejoin.status === 201);

  const promote = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:B']}`, { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) }, 'A');
  check('A promotes B → owner', promote.status === 200 && promote.body?.role === 'owner');
  const bRenameOk = await api(`/api/portal/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ name: ALPHA }) }, 'B');
  check('promoted B can rename', bRenameOk.status === 200);
  const demote = await api(`/api/portal/orgs/${ids.orgAlpha}/members/${ids['user:B']}`, { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }, 'A');
  check('A demotes B back (2 owners → allowed)', demote.status === 200 && demote.body?.role === 'member');

  // --- gateway: org balance gate + debits + log attribution -------------------
  const { port } = await startMockUpstream();
  const prov = await api('/api/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: PROVIDER_NAME, adapter: 'openai', base_url: `http://127.0.0.1:${port}/v1` }),
  });
  check('create smoke provider', prov.status === 201);
  ids.provId = prov.body?.id;
  const model = await api('/api/admin/models', {
    method: 'POST',
    body: JSON.stringify({ provider_id: ids.provId, slug: SLUG, pricing_input: 2, pricing_output: 8 }),
  });
  check('create smoke model (priced $2/$8 per 1M)', model.status === 201);

  const gw = (rawKey, body) =>
    fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(rawKey ? { authorization: `Bearer ${rawKey}` } : {}) },
      body: JSON.stringify(body ?? { model: SLUG, messages: [{ role: 'user', content: 'hi' }] }),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), res }));

  const broke = await gw(k2.body.key);
  check('org balance 0 → gateway 429 insufficient_quota', broke.status === 429 && broke.body?.error?.code === 'insufficient_quota', JSON.stringify(broke.body?.error));

  const adj = await api(`/api/admin/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ balance_adjust_usd: 5, note: 'smoke grant' }) });
  check('admin +$5 org adjustment → balance 5', adj.status === 200 && adj.body?.balance_usd === 5 && adj.body?.member_count === 2 && adj.body?.key_count === 2);

  const ok1 = await gw(k2.body.key);
  check('funded org → gateway 200', ok1.status === 200 && ok1.body?.usage?.total_tokens === 8);
  const streamRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${k1.body.key}` },
    body: JSON.stringify({ model: SLUG, messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check('org key streamed call → 200 SSE', streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'));
  await streamRes.text();

  const want5 = 5 - 2 * DEBIT_USD;
  const orgBal = await waitFor(async () => {
    const b = await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A');
    const bal = b.body?.balance_usd;
    return bal != null && Math.abs(bal - want5) < 1e-9 ? bal : null;
  });
  check(`org debits: 2 calls × ${DEBIT_MICROS_PER_CALL} µ$ land (incl. streamed)`, orgBal != null, String(orgBal));

  const ledger = await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A');
  const usageEntries = (ledger.body?.entries ?? []).filter((e) => e.kind === 'usage');
  check('org ledger records usage debits', usageEntries.length >= 2 && usageEntries.every((e) => Math.abs(e.delta_usd + DEBIT_USD) < 1e-9));

  const logs = await api('/api/admin/logs?limit=50');
  const k2Log = (logs.body ?? []).find((l) => l.api_key_id === ids.keyK2 && l.status === 200);
  const k1Log = (logs.body ?? []).find((l) => l.api_key_id === ids.keyK1 && l.status === 200);
  check('logs carry user+org attribution (K2 → B)', k2Log?.user_id === ids['user:B'] && k2Log?.user_email === email('B') && k2Log?.org_id === ids.orgAlpha && k2Log?.org_name === ALPHA, JSON.stringify(k2Log && { u: k2Log.user_email, o: k2Log.org_name }));
  check('logs carry user+org attribution (K1 → A)', k1Log?.user_id === ids['user:A'] && k1Log?.org_id === ids.orgAlpha);

  // Org billing isolation: Beta stays flat broke while Alpha spends.
  const kb = await api(`/api/portal/orgs/${ids.orgBeta}/keys`, { method: 'POST', body: JSON.stringify({ name: 'M9 KB (smoke)' }) }, 'B');
  ids.keyKB = kb.body?.id;
  const betaBroke = await gw(kb.body.key);
  check('Beta (0 balance) → 429 — orgs never share balances', betaBroke.status === 429 && betaBroke.body?.error?.code === 'insufficient_quota');
  const alphaUnaffected = await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A');
  check('Alpha balance untouched by Beta attempt', Math.abs(alphaUnaffected.body?.balance_usd - want5) < 1e-9);

  // Drain Alpha below zero → 429 again.
  await api(`/api/admin/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ balance_adjust_usd: -(want5 + 0.01) }) });
  const drained = await gw(k1.body.key);
  check('drained org → 429', drained.status === 429 && drained.body?.error?.code === 'insufficient_quota');

  // Admin disable: a disabled org refuses at the gateway too.
  await api(`/api/admin/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  const disabled = await gw(k1.body.key);
  check('admin-disabled org → 429', disabled.status === 429);
  await api(`/api/admin/orgs/${ids.orgAlpha}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });

  // --- org webhook credit path -------------------------------------------------
  const cfg = await api('/api/admin/billing/config', {
    method: 'PATCH',
    body: JSON.stringify({ store_id: `smoke-store-${RUN}`, variant_id: `smoke-variant-${RUN}`, api_key: 'sk_ls_smoke', webhook_secret: 'whsec_smoke' }),
  });
  check('billing config saved', cfg.status === 200);
  const webhook = async (payloadObj, sig) => {
    const raw = JSON.stringify(payloadObj);
    const res = await fetch(base + '/webhooks/lemonsqueezy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig } : {}) },
      body: raw,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const orgOrder = (orderId) => ({
    meta: { event_name: 'order_created', custom_data: { org_id: ids.orgAlpha } },
    data: { type: 'orders', id: orderId, attributes: { store_id: 1, currency: 'USD', subtotal: 1000, discount_total: 0, tax: 0, total: 1000, status: 'paid', refunded: false } },
  });
  const noSig = await webhook(orgOrder(`ord-${RUN}-a`), undefined);
  check('org webhook without signature → 401', noSig.status === 401);

  const balBefore = (await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A')).body.balance_usd;
  const topup = await webhook(orgOrder(`ord-${RUN}-1`), sign('whsec_smoke', JSON.stringify(orgOrder(`ord-${RUN}-1`))));
  const want10 = balBefore + 10;
  const afterTopup = await waitFor(async () => {
    const b = await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A');
    return b.body?.balance_usd != null && Math.abs(b.body.balance_usd - want10) < 1e-9 ? b.body.balance_usd : null;
  });
  check('signed org order $10 → credited to org', topup.status === 200 && topup.body?.credited_usd === 10 && afterTopup != null, JSON.stringify(topup.body));

  const replay = await webhook(orgOrder(`ord-${RUN}-1`), sign('whsec_smoke', JSON.stringify(orgOrder(`ord-${RUN}-1`))));
  const afterReplay = (await api(`/api/portal/orgs/${ids.orgAlpha}/billing`, {}, 'A')).body.balance_usd;
  check('replayed org webhook → duplicate, no double credit', replay.body?.duplicate === true && Math.abs(afterReplay - want10) < 1e-9);

  const ghost = orgOrder(`ord-${RUN}-3`);
  ghost.meta.custom_data.org_id = 'no-such-org';
  const unknownOrg = await webhook(ghost, sign('whsec_smoke', JSON.stringify(ghost)));
  check('webhook for unknown org → ok + ignored', unknownOrg.status === 200 && unknownOrg.body?.ok === true && !unknownOrg.body?.credited_usd);

  const revived = await gw(k2.body.key);
  check('org works again after webhook top-up → 200', revived.status === 200);

  // --- checkout API (owner-only) + bounds --------------------------------------
  const coMember = await api(`/api/portal/orgs/${ids.orgAlpha}/billing/checkout`, { method: 'POST', body: JSON.stringify({ amount_usd: 10 }) }, 'B');
  check('member checkout → 403', coMember.status === 403);
  const coOwner = await api(`/api/portal/orgs/${ids.orgAlpha}/billing/checkout`, { method: 'POST', body: JSON.stringify({ amount_usd: 10 }) }, 'A');
  check('owner checkout with fake LS creds → 502 surfaced', coOwner.status === 502 && typeof coOwner.body?.error === 'string');
  const coBad = await api(`/api/portal/orgs/${ids.orgAlpha}/billing/checkout`, { method: 'POST', body: JSON.stringify({ amount_usd: 9999 }) }, 'A');
  check('checkout amount out of bounds → 400', coBad.status === 400);

  // --- code rotation + admin succession ----------------------------------------
  const rot = await api(`/api/portal/orgs/${ids.orgAlpha}/regenerate-code`, { method: 'POST' }, 'A');
  check('owner rotates join code', rot.status === 200 && rot.body?.join_code.length === 10 && rot.body?.join_code !== code1);
  const oldCode = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: code1 }) }, 'D');
  check('old code dead after rotation → 404', oldCode.status === 404);
  const dJoin = await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: rot.body?.join_code }) }, 'D');
  check('D joins with fresh code', dJoin.status === 201);

  // Succession: C inherits Gamma when owner D is deleted; empty orgs would die.
  const gamma = await api('/api/portal/orgs', { method: 'POST', body: JSON.stringify({ name: GAMMA }) }, 'D');
  ids.orgGamma = gamma.body?.id;
  const gammaCode = (await api(`/api/portal/orgs/${ids.orgGamma}`, {}, 'D')).body?.join_code;
  await api('/api/portal/orgs/join', { method: 'POST', body: JSON.stringify({ code: gammaCode }) }, 'C');
  const delD = await api(`/api/admin/users/${ids['user:D']}`, { method: 'DELETE' });
  const cOrgs = await api('/api/portal/orgs', {}, 'C');
  const gammaAsC = cOrgs.body?.find((o) => o.id === ids.orgGamma);
  check('admin deletes owner D → C inherits Gamma as owner', delD.status === 200 && gammaAsC?.role === 'owner', JSON.stringify(cOrgs.body?.map((o) => o.name)));
  const alphaMemberIds = (await api(`/api/portal/orgs/${ids.orgAlpha}`, {}, 'A')).body?.members?.map((m) => m.user_id) ?? [];
  check('deleted user D gone from Alpha members', !alphaMemberIds.includes(ids['user:D']));
  jar.D = '';

  // --- admin org management ------------------------------------------------------
  const adminOrgs = await api('/api/admin/orgs');
  const alphaAdmin = (adminOrgs.body ?? []).find((o) => o.id === ids.orgAlpha);
  // A + B — D joined earlier but was deleted in the succession step.
  check('admin org list shows Alpha with counts', alphaAdmin?.member_count === 2 && alphaAdmin?.key_count === 2 && alphaAdmin?.enabled === true, JSON.stringify(alphaAdmin));

  const delBeta = await api(`/api/admin/orgs/${ids.orgBeta}`, { method: 'DELETE' });
  const betaAfter = await api(`/api/portal/orgs/${ids.orgBeta}`, {}, 'B');
  check('admin deletes Beta → member B loses access', delBeta.status === 200 && betaAfter.status === 404);
  const keysAfter = await api('/api/admin/api-keys');
  check('Beta org keys deleted with the org', !(keysAfter.body ?? []).some((k) => k.org_id === ids.orgBeta));

  // --- cleanup ---------------------------------------------------------------------
  await cleanup({ restoreSignup: settings0.body?.public_signup ?? 'on' });
  const usersLeft = await api('/api/admin/users');
  check('cleanup: no smoke users left', !(usersLeft.body ?? []).some((u) => u.email.includes(RUN)));
  const orgsLeft = await api('/api/admin/orgs');
  check('cleanup: no smoke orgs left', !(orgsLeft.body ?? []).some((o) => o.name?.includes(RUN) || o.name?.startsWith('M9 ')));
  const provsLeft = await api('/api/admin/providers');
  check('cleanup: no smoke provider left', !(provsLeft.body ?? []).some((p) => p.name === PROVIDER_NAME));
  const balLeft = await api(`/api/portal/me`, {}, 'A');
  check('cleanup: deleted user session dead (401)', balLeft.status === 401);

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
