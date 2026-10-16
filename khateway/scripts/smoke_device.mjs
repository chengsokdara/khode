// Device-flow smoke test (RFC 8628 onboarding) — against `wrangler dev` on
// :8787 (needs `npm run dev` running first).
//
// Exercises the khode sign-in path end to end, without a mock upstream:
//   1. POST /api/v1/device/code mints a shaped request (device_code hex,
//      user_code XXXX-XXXX, verification URLs, ttl + interval); polling it
//      answers authorization_pending
//   2. the approve surface is portal-session-gated (401 anonymous; bad
//      format 400; unknown code 404)
//   3. a signed-up user approves → the next poll returns a ONE-SHOT personal
//      key (re-poll = expired_token) for that account
//   4. the key behaves like any portal key: /v1/models 200, /api/v1/credits
//      user scope, visible in the portal keys list
//   5. deny path → access_denied; garbage device_code → expired_token
// Fixtures are unique-per-run emails; device rows expire on their own.
const base = 'http://127.0.0.1:8787';
let failures = 0;
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
};
const pass = (name, detail = '') => console.log(`PASS — ${name}${detail ? ` [${detail}]` : ''}`);
const check = (name, cond, detail = '') => (cond ? pass(name, detail) : fail(name, detail));

const EMAIL = `device-smoke-${Date.now()}@khateway.test`;
const PASSWORD = 'device-smoke-password';
const DISPLAY = 'khode on smokebox';

/** Separate cookie jars: the admin console (khateway_session) and the portal
 * (khateway_user) are independent sessions. */
function jar(name) {
  let cookie = '';
  return async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie?.includes(`${name}=`) && !setCookie.includes('Max-Age=0')) {
      cookie = `${name}=${setCookie.split(`${name}=`)[1].split(';')[0]}`;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // no JSON body
    }
    return { status: res.status, body, headers: res.headers };
  };
}
const portal = jar('khateway_user');
const anon = jar('khateway_user');

const deviceCode = (b) => b?.device_code;

// 1. mint ---------------------------------------------------------------
const mint = await anon('/api/v1/device/code', { method: 'POST', body: JSON.stringify({ display_name: DISPLAY }) });
check(
  'mint: 201 with shaped body',
  mint.status === 201 &&
    /^[0-9a-f]{64}$/.test(deviceCode(mint.body) ?? '') &&
    /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(mint.body?.user_code ?? '') &&
    mint.body?.verification_uri?.endsWith('/app/device') &&
    mint.body?.verification_uri_complete?.includes(`?code=${mint.body?.user_code}`) &&
    mint.body?.expires_in === 600 &&
    mint.body?.interval === 5,
  JSON.stringify({ ...mint.body, device_code: (deviceCode(mint.body) ?? '').slice(0, 8) + '…' }),
);

const mint2 = await anon('/api/v1/device/code', { method: 'POST', body: JSON.stringify({ display_name: 'deny me' }) });
check('mint: second request independent (different codes)', mint2.status === 201 && deviceCode(mint2.body) !== deviceCode(mint.body), String(mint2.status));

// 2. pending poll -------------------------------------------------------
const pollPending = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({ device_code: deviceCode(mint.body) }) });
check('poll before approval → 400 authorization_pending', pollPending.status === 400 && pollPending.body?.error === 'authorization_pending', JSON.stringify(pollPending.body));

// 3. approval surface is session-gated ----------------------------------
const anonInfo = await anon(`/api/portal/device/${mint.body.user_code}`);
check('device info without a portal session → 401', anonInfo.status === 401, String(anonInfo.status));
const anonApprove = await anon(`/api/portal/device/${mint.body.user_code}/approve`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
check('approve without a portal session → 401', anonApprove.status === 401, String(anonApprove.status));

const signup = await portal('/api/portal/signup', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
check('portal signup for the approver → 201', signup.status === 201 && signup.body?.user?.email === EMAIL, JSON.stringify(signup.body?.user?.email));

const badFormat = await portal('/api/portal/device/zzz!bad');
check('device info with a bad-format code → 400', badFormat.status === 400, String(badFormat.status));
const unknownCode = await portal('/api/portal/device/AAAA-BBBB');
check('device info with a well-formed unknown code → 404', unknownCode.status === 404, String(unknownCode.status));

const info = await portal(`/api/portal/device/${mint.body.user_code}`);
check(
  'device info (approver session) → pending + display name',
  info.status === 200 && info.body?.status === 'pending' && info.body?.display_name === DISPLAY,
  JSON.stringify(info.body),
);

const badAction = await portal(`/api/portal/device/${mint.body.user_code}/approve`, { method: 'POST', body: JSON.stringify({ action: 'maybe' }) });
check('approve with a bogus action → 400', badAction.status === 400, String(badAction.status));

// 4. approve → one-shot grant -------------------------------------------
const approve = await portal(`/api/portal/device/${mint.body.user_code}/approve`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
check('approve → ok / approved', approve.status === 200 && approve.body?.status === 'approved', JSON.stringify(approve.body));

const infoAfter = await portal(`/api/portal/device/${mint.body.user_code}`);
check('device info after approval → status approved', infoAfter.body?.status === 'approved', JSON.stringify(infoAfter.body));

const poll = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({ device_code: deviceCode(mint.body) }) });
check(
  'poll after approval → 200 with personal key + account',
  poll.status === 200 &&
    typeof poll.body?.access_token === 'string' &&
    poll.body.access_token.startsWith('khat-') &&
    poll.body?.token_type === 'bearer' &&
    poll.body?.key?.name === DISPLAY &&
    poll.body?.user?.email === EMAIL &&
    poll.body?.user?.balance_usd === 0,
  JSON.stringify({ ...poll.body, access_token: (poll.body?.access_token ?? '').slice(0, 9) + '…' }),
);
const key = poll.body?.access_token;

const repoll = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({ device_code: deviceCode(mint.body) }) });
check('re-poll after the grant → 400 expired_token (one-shot)', repoll.status === 400 && repoll.body?.error === 'expired_token', JSON.stringify(repoll.body));

// 5. the issued key behaves like any portal key -------------------------
const models = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${key}` } });
check('issued key works at the gateway: GET /v1/models → 200', models.status === 200, String(models.status));
const credits = await anon('/api/v1/credits', { headers: { authorization: `Bearer ${key}` } });
check(
  'issued key at /api/v1/credits → user scope, zero balance',
  credits.status === 200 && credits.body?.data?.scope === 'user' && credits.body?.data?.total_credits === 0,
  JSON.stringify(credits.body?.data),
);
const portalKeys = await portal('/api/portal/keys');
check(
  'device key is a visible, revocable portal key',
  Array.isArray(portalKeys.body) && portalKeys.body.some((k) => k.name === DISPLAY && k.key_prefix === poll.body?.key?.key_prefix),
  JSON.stringify(portalKeys.body?.map((k) => k.name)),
);

// 6. deny path ----------------------------------------------------------
const denyApprove = await portal(`/api/portal/device/${mint2.body.user_code}/approve`, { method: 'POST', body: JSON.stringify({ action: 'deny' }) });
check('deny → ok / denied', denyApprove.status === 200 && denyApprove.body?.status === 'denied', JSON.stringify(denyApprove.body));
const pollDenied = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({ device_code: deviceCode(mint2.body) }) });
check('poll after denial → 400 access_denied', pollDenied.status === 400 && pollDenied.body?.error === 'access_denied', JSON.stringify(pollDenied.body));

// 7. garbage device_code ------------------------------------------------
const garbage = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({ device_code: 'deadbeef'.repeat(8) }) });
check('poll with an unknown device_code → 400 expired_token', garbage.status === 400 && garbage.body?.error === 'expired_token', JSON.stringify(garbage.body));
const noCode = await anon('/api/v1/device/token', { method: 'POST', body: JSON.stringify({}) });
check('poll without device_code → 400 expired_token', noCode.status === 400 && noCode.body?.error === 'expired_token', String(noCode.status));

// revoke the issued key so repeat runs don't accumulate portal keys
const keys = await portal('/api/portal/keys');
for (const k of keys.body ?? []) {
  if (k.name === DISPLAY || k.name === 'deny me') await portal(`/api/portal/keys/${k.id}`, { method: 'DELETE' });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
