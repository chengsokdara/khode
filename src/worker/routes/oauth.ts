// /api/portal/oauth — social sign-in (Google + GitHub) for the portal.
//
// A pure OAuth 2.0 authorization-code flow on fetch (no SDKs): /start 302s to
// the provider with a random `state`; /callback verifies the state COOKIE
// (HttpOnly, SameSite=Lax, 10 min — a browser surface, so every failure is a
// redirect to /app/login?error=…, never JSON), exchanges the code, fetches
// the profile, and links-or-creates the account (db/oauth.ts) before minting
// a regular portal session (khateway_user cookie — identical to password
// login). `next` travels inside the state cookie and the callback only
// redirects to /app paths — no open redirects, and the khode device-flow
// round-trip survives untouched (?next=/app/device?code=…).
//
// MOUNTED DEEPER than /api/portal and BEFORE portalApp so the portal's
// `portalAuth` catch-all middleware can never swallow these anonymous routes
// (same ordering rule as device.ts vs clientapi).
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../env';
import { b64urlDecode, b64urlEncode, safeEqualStr } from '../crypto';
import { isSecureRequest, createUserSessionToken, USER_SESSION_COOKIE, USER_SESSION_TTL_SECONDS, loginAllowed } from '../auth';
import { getPublicSignup } from '../db/settings';
import { getOAuthConfig, isValidProvider, type OAuthProvider } from '../oauth/config';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchProviderProfile } from '../oauth/providers';
import { applyOAuthSignInDecision, decideOAuthSignIn, findOAuthIdentity, findUserByEmail } from '../db/oauth';

type OAuthEnv = { Bindings: Env };

export const oauthApp = new Hono<OAuthEnv>();

const OAUTH_STATE_COOKIE = 'khateway_oauth';
const OAUTH_STATE_TTL_SECONDS = 600; // 10 min: enough to clear the provider, short enough to be worthless replayed
const OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_SECONDS * 1000;

const PROVIDER_LABELS: Record<OAuthProvider, string> = { google: 'Google', github: 'GitHub' };

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The only redirect target the flow may return to — same rule as the login
 * page (relative /app paths, never the login page itself, else default). */
function sanitizeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith('/app') && !raw.startsWith('/app/login') ? raw : '/app';
}

/** Every failure funnels here: the login page surfaces ?error= inline and
 * keeps ?next= so the device-flow destination still survives the detour. */
function loginRedirect(next: string, error: string): Response {
  const params = new URLSearchParams({ error });
  if (next !== '/app') params.set('next', next);
  return new Response(null, { status: 302, headers: { location: `/app/login?${params.toString()}` } });
}

// ------------------------------------------------------------------ state
// Pure helpers (offline-tested): the state cookie binds the flow to ONE
// provider, ONE destination and TEN minutes — the ?state echoed by the
// provider must match the random inside it, timing-safely.

export interface OAuthStatePair {
  stateParam: string;
  cookieValue: string;
}

export function createOAuthState(provider: OAuthProvider, next: string, now = Date.now()): OAuthStatePair {
  const stateParam = randomHex(32);
  const payload = { r: stateParam, p: provider, n: next, e: now + OAUTH_STATE_TTL_MS };
  return { stateParam, cookieValue: b64urlEncode(new TextEncoder().encode(JSON.stringify(payload))) };
}

export function verifyOAuthState(cookieValue: string | undefined, provider: OAuthProvider, queryState: string, now: number): { ok: true; next: string } | { ok: false } {
  if (!cookieValue || !queryState) return { ok: false };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(cookieValue)));
  } catch {
    return { ok: false };
  }
  const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (!rec) return { ok: false };
  const random = typeof rec.r === 'string' ? rec.r : '';
  if (rec.p !== provider) return { ok: false };
  if (typeof rec.e !== 'number' || rec.e <= now) return { ok: false };
  if (!random || !safeEqualStr(random, queryState)) return { ok: false };
  return { ok: true, next: sanitizeNext(typeof rec.n === 'string' ? rec.n : '') };
}

function refuseMessage(reason: 'user_disabled' | 'signup_disabled' | 'no_email', provider: OAuthProvider): string {  switch (reason) {
    case 'user_disabled':
      return 'This account has been disabled.';
    case 'signup_disabled':
      return 'Sign-ups are disabled on this instance — ask the administrator for access.';
    case 'no_email':
      return `${PROVIDER_LABELS[provider]} did not share an email address — use email sign-in instead.`;
  }
}

function outcomeMessage(reason: 'email_exists' | 'identity_conflict' | 'no_email'): string {
  switch (reason) {
    case 'email_exists':
      return 'An account with this email already exists — sign in with your password instead.';
    case 'identity_conflict':
      return 'Sign-in could not be completed — please try again.';
    case 'no_email':
      return 'The provider did not share an email address — use email sign-in instead.';
  }
}

// ------------------------------------------------------------------ start

oauthApp.get('/:provider/start', async (c) => {
  const next = sanitizeNext(c.req.query('next'));
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!loginAllowed('oauth-start', ip, 20)) return loginRedirect(next, 'Too many attempts — try again in a minute.');

  const providerParam = c.req.param('provider');
  if (!isValidProvider(providerParam)) return loginRedirect(next, 'Unknown sign-in provider.');
  const cfg = await getOAuthConfig(c.env, providerParam);
  if (!cfg) return loginRedirect(next, `${PROVIDER_LABELS[providerParam]} sign-in is not configured on this instance.`);

  const { stateParam, cookieValue } = createOAuthState(providerParam, next);
  setCookie(c, OAUTH_STATE_COOKIE, cookieValue, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: OAUTH_STATE_TTL_SECONDS,
    secure: isSecureRequest(c),
  });
  const origin = new URL(c.req.url).origin;
  const authorizeUrl = buildAuthorizeUrl(providerParam, {
    clientId: cfg.clientId,
    redirectUri: `${origin}/api/portal/oauth/${providerParam}/callback`,
    state: stateParam,
  });
  return c.redirect(authorizeUrl, 302);
});

// --------------------------------------------------------------- callback

oauthApp.get('/:provider/callback', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!loginAllowed('oauth-callback', ip, 20)) return loginRedirect('/app', 'Too many attempts — try again in a minute.');

  const providerParam = c.req.param('provider');
  if (!isValidProvider(providerParam)) return loginRedirect('/app', 'Unknown sign-in provider.');
  const provider: OAuthProvider = providerParam;

  // One-shot: consume the state cookie whatever happens — a used/expired
  // state must never validate a second request.
  const stateCookie = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
  const verified = verifyOAuthState(stateCookie, provider, c.req.query('state') ?? '', Date.now());
  if (!verified.ok) return loginRedirect('/app', 'Sign-in session expired or invalid — please try again.');

  const code = c.req.query('code') ?? '';
  if (!code) return loginRedirect('/app', `${PROVIDER_LABELS[provider]} did not return an authorization code — please try again.`);

  const cfg = await getOAuthConfig(c.env, provider);
  if (!cfg) return loginRedirect('/app', `${PROVIDER_LABELS[provider]} sign-in is not configured on this instance.`);

  const origin = new URL(c.req.url).origin;
  try {
    const accessToken = await exchangeCodeForToken(provider, {
      code,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: `${origin}/api/portal/oauth/${provider}/callback`,
    });
    const profile = await fetchProviderProfile(provider, accessToken);

    const signupAllowed = (await getPublicSignup(c.env)) !== 'off';
    const identity = await findOAuthIdentity(c.env, profile.provider, profile.providerUserId);
    // Rule (b) input: the email lookup runs ONLY on a provider-verified address.
    const verifiedEmailMatch = profile.emailVerified && profile.email ? await findUserByEmail(c.env, profile.email) : null;
    const decision = decideOAuthSignIn({ profile, identity, verifiedEmailMatch, signupAllowed });
    if (decision.action === 'refuse') return loginRedirect('/app', refuseMessage(decision.reason, provider));

    const outcome = await applyOAuthSignInDecision(c.env, profile, decision);
    if (!outcome.ok) return loginRedirect('/app', outcomeMessage(outcome.reason));

    // Regular portal session — byte-for-byte the cookie a password login sets.
    const sessionToken = await createUserSessionToken(c.env, outcome.userId);
    setCookie(c, USER_SESSION_COOKIE, sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: USER_SESSION_TTL_SECONDS,
      secure: isSecureRequest(c),
    });
    return c.redirect(verified.next, 302);
  } catch (err) {
    // Token exchange / profile fetch / DB failure — the browser gets a calm
    // redirect, the detail lands in the server logs.
    console.error('[khateway oauth]', err);
    return loginRedirect('/app', `${PROVIDER_LABELS[provider]} sign-in failed — please try again.`);
  }
});
