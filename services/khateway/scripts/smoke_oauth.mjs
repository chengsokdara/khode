// Social sign-in (OAuth) smoke test — against `wrangler dev` on :8787 (needs
// `npm run dev` running first). Failure-path coverage only: real Google/GitHub
// round-trips are manual (see README).
//
//   1. unconfigured / unknown provider / no-state callback all redirect to
//      /app/login?error=… — never JSON, and never a 401 from the portal's
//      portalAuth middleware (proves the mount ordering of /api/portal/oauth)
//   2. with FAKE google credentials configured: /start 302s to the Google
//      authorize URL with state + redirect_uri params and sets the state
//      cookie; the `next` destination rides the error redirect back
//   3. callback with a mismatched state → error redirect; a garbage code →
//      error redirect (token exchange fails), replay included
//   4. settings restore: fake rows are cleared (only when google started
//      unconfigured; a pre-configured provider is never touched)
const base = 'http://127.0.0.1:8787';
let failures = 0;
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
};
const pass = (name, detail = '') => console.log(`PASS — ${name}${detail ? ` [${detail}]` : ''}`);
const check = (name, cond, detail = '') => (cond ? pass(name, detail) : fail(name, detail));

/** Admin console session (khateway_session cookie). */
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
const admin = jar('khateway_session');

/** OAuth endpoints are browser surfaces — no redirects followed, JSON bodies
 * impossible on the failure paths, state cookie captured when set. */
async function oauth(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie') ?? '';
  let oauthCookie = null;
  if (setCookie.includes('khateway_oauth=')) {
    oauthCookie = setCookie.split('khateway_oauth=')[1].split(';')[0];
  }
  return { status: res.status, location: res.headers.get('location') ?? '', oauthCookie };
}

const isLoginError = (r, marker) =>
  r.status === 302 &&
  r.location.startsWith('/app/login?') &&
  r.location.includes('error=') &&
  (marker ? r.location.includes(marker) : true) &&
  !r.location.includes('error=undefined');

// 0. admin session -------------------------------------------------------
const login = await admin('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) });
check('admin login → 200', login.status === 200, String(login.status));

const initial = await admin('/api/admin/settings/oauth');
check(
  'GET /api/admin/settings/oauth → both providers shaped with callback URLs',
  initial.status === 200 &&
    typeof initial.body?.google?.configured === 'boolean' &&
    typeof initial.body?.github?.configured === 'boolean' &&
    initial.body?.google?.callback_url?.endsWith('/api/portal/oauth/google/callback') &&
    initial.body?.github?.callback_url?.endsWith('/api/portal/oauth/github/callback'),
  JSON.stringify(initial.body?.google),
);
const googleWasConfigured = initial.body?.google?.configured === true;

// 1. unconfigured / unknown / no-state failures --------------------------
const unconfigured = await oauth('/api/portal/oauth/google/start');
check(
  'unconfigured google start → login redirect with error (NOT 401 — mount order)',
  isLoginError(unconfigured) && unconfigured.location.includes('not+configured'),
  unconfigured.location,
);

const unknownProvider = await oauth('/api/portal/oauth/nope/start');
check('unknown provider start → login redirect with error', isLoginError(unknownProvider), unknownProvider.location);

const noState = await oauth('/api/portal/oauth/google/callback?state=x');
check('callback without a state cookie → login redirect with error', isLoginError(noState), noState.location);

const badProviderCallback = await oauth('/api/portal/oauth/microsoft/callback');
check('callback for an unknown provider → login redirect with error', isLoginError(badProviderCallback), badProviderCallback.location);

// `next` preservation on failure: the device-flow destination must survive.
const unconfiguredNext = await oauth(`/api/portal/oauth/google/start?next=${encodeURIComponent('/app/device?code=ABCD-2345')}`);
check(
  'unconfigured start preserves ?next= in the error redirect',
  isLoginError(unconfiguredNext) && unconfiguredNext.location.includes(encodeURIComponent('/app/device?code=ABCD-2345')),
  unconfiguredNext.location,
);

if (googleWasConfigured) {
  console.log('SKIP — google was already configured; fake-credential steps skipped (real secrets are not readable back)');
} else {
  // 2. configure FAKE google creds ----------------------------------------
  const saved = await admin('/api/admin/settings/oauth', {
    method: 'PATCH',
    body: JSON.stringify({ google: { client_id: 'smoke-client-id.apps.googleusercontent.com', client_secret: 'smoke-client-secret' } }),
  });
  check(
    'PATCH fake google creds → configured, client_id echoed in full',
    saved.status === 200 && saved.body?.google?.configured === true && saved.body?.google?.client_id?.startsWith('smoke-client-id'),
    JSON.stringify(saved.body?.google),
  );

  const start = await oauth(`/api/portal/oauth/google/start?next=${encodeURIComponent('/app/device?code=ABCD-2345')}`);
  let authorizeParams = null;
  try {
    authorizeParams = new URL(start.location).searchParams;
  } catch {
    // location was not an authorize URL
  }
  check(
    'configured start → 302 to Google authorize with state + redirect_uri + state cookie set',
    start.status === 302 &&
      start.location.startsWith('https://accounts.google.com/o/oauth2/v2/auth') &&
      authorizeParams?.get('client_id') === 'smoke-client-id.apps.googleusercontent.com' &&
      /^[0-9a-f]{64}$/.test(authorizeParams?.get('state') ?? '') &&
      authorizeParams?.get('redirect_uri') === `${base}/api/portal/oauth/google/callback` &&
      typeof start.oauthCookie === 'string' &&
      start.oauthCookie.length > 32,
    start.location,
  );

  // 3. mismatched state → error --------------------------------------------
  const wrongState = await oauth(`/api/portal/oauth/google/callback?state=${'ab'.repeat(32)}&code=whatever`);
  check('callback with a mismatched state → login redirect with error', isLoginError(wrongState), wrongState.location);

  // 3b. valid state + garbage code: the token exchange fails (offline or at
  // Google — either way the browser gets the error redirect). A replay with
  // the same kept-alive cookie errors identically: no code can validate, and
  // the browser's own copy of the cookie was cleared by the first callback.
  const start2 = await oauth('/api/portal/oauth/google/start');
  const state2 = new URL(start2.location).searchParams.get('state');
  const cookie2 = start2.oauthCookie;
  const first = await fetch(`${base}/api/portal/oauth/google/callback?state=${state2}&code=garbage-code`, {
    redirect: 'manual',
    headers: { cookie: `khateway_oauth=${cookie2}` },
  });
  check(
    'valid state + garbage code → error redirect (token exchange fails)',
    first.status === 302 && first.headers.get('location')?.startsWith('/app/login?') && first.headers.get('location')?.includes('error='),
    first.headers.get('location') ?? '',
  );
  const second = await fetch(`${base}/api/portal/oauth/google/callback?state=${state2}&code=garbage-code`, {
    redirect: 'manual',
    headers: { cookie: `khateway_oauth=${cookie2}` },
  });
  check(
    'replayed callback with a garbage code → error redirect again',
    second.status === 302 && second.headers.get('location')?.includes('error='),
    second.headers.get('location') ?? '',
  );

  // 5. restore: the smoke configured google from an unconfigured state ------
  const cleared = await admin('/api/admin/settings/oauth', {
    method: 'PATCH',
    body: JSON.stringify({ google: { client_id: null, client_secret: null } }),
  });
  check('cleanup: fake google rows cleared → provider unconfigured again', cleared.status === 200 && cleared.body?.google?.configured === false, JSON.stringify(cleared.body?.google));
  const afterClear = await oauth('/api/portal/oauth/google/start');
  check('after clearing, start errors again', isLoginError(afterClear), afterClear.location);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
