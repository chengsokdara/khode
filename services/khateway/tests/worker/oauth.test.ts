// Offline unit tests for social sign-in: the pure link-or-create decision
// (the security-critical half), the state-cookie helpers, and the provider
// profile normalizers. No DB, no HTTP — the fetchful halves of the flow are
// covered by scripts/smoke_oauth.mjs (failure paths) + manual round-trips.
import { describe, expect, it } from 'vitest';
import { decideOAuthSignIn, type OAuthSignInInput } from '../../src/worker/db/oauth';
import { createOAuthState, verifyOAuthState } from '../../src/worker/routes/oauth';
import { buildAuthorizeUrl, normalizeGithubProfile, normalizeGoogleProfile } from '../../src/worker/oauth/providers';
import type { OAuthProfile } from '../../src/worker/oauth/providers';

// ----------------------------------------------------------------- decision

function profile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return { provider: 'github', providerUserId: 'gh-1', email: 'user@example.com', emailVerified: true, ...overrides };
}

function input(overrides: Partial<OAuthSignInInput> = {}): OAuthSignInInput {
  return {
    profile: profile(),
    identity: null,
    verifiedEmailMatch: null,
    signupAllowed: true,
    ...overrides,
  };
}

describe('decideOAuthSignIn', () => {
  it('(a) existing identity signs that user in', () => {
    expect(decideOAuthSignIn(input({ identity: { userId: 'u1', enabled: true } }))).toEqual({ action: 'sign_in', userId: 'u1' });
  });

  it('(a) identity on a disabled user refuses', () => {
    expect(decideOAuthSignIn(input({ identity: { userId: 'u1', enabled: false } }))).toEqual({ action: 'refuse', reason: 'user_disabled' });
  });

  it('(b) provider-verified email match links', () => {
    expect(decideOAuthSignIn(input({ verifiedEmailMatch: { id: 'u2', enabled: true } }))).toEqual({ action: 'link', userId: 'u2' });
  });

  it('(b) verified email matching a disabled user refuses', () => {
    expect(decideOAuthSignIn(input({ verifiedEmailMatch: { id: 'u2', enabled: false } }))).toEqual({ action: 'refuse', reason: 'user_disabled' });
  });

  it('UNVERIFIED email never links — falls through to create even with a matching user', () => {
    const d = decideOAuthSignIn(input({ profile: profile({ emailVerified: false }), verifiedEmailMatch: { id: 'u2', enabled: true } }));
    expect(d).toEqual({ action: 'create' });
  });

  it('verified guard is also re-checked: unverified + signup closed refuses, never links', () => {
    const d = decideOAuthSignIn(input({ profile: profile({ emailVerified: false }), verifiedEmailMatch: { id: 'u2', enabled: true }, signupAllowed: false }));
    expect(d).toEqual({ action: 'refuse', reason: 'signup_disabled' });
  });

  it('(c) no match + signup open creates', () => {
    expect(decideOAuthSignIn(input())).toEqual({ action: 'create' });
  });

  it('(c) no match + signup closed refuses', () => {
    expect(decideOAuthSignIn(input({ signupAllowed: false }))).toEqual({ action: 'refuse', reason: 'signup_disabled' });
  });

  it('no email at all refuses (cannot even create)', () => {
    expect(decideOAuthSignIn(input({ profile: profile({ email: null, emailVerified: false }), signupAllowed: true }))).toEqual({
      action: 'refuse',
      reason: 'no_email',
    });
  });
});

// ------------------------------------------------------------- state cookie

describe('OAuth state cookie', () => {
  it('round-trips: correct provider + state verifies and preserves next', () => {
    const { stateParam, cookieValue } = createOAuthState('google', '/app/device?code=ABCD-2345', 1000);
    expect(verifyOAuthState(cookieValue, 'google', stateParam, 2000)).toEqual({ ok: true, next: '/app/device?code=ABCD-2345' });
  });

  it('expires after its 10-minute window', () => {
    const { stateParam, cookieValue } = createOAuthState('github', '/app', 1000);
    expect(verifyOAuthState(cookieValue, 'github', stateParam, 1000 + 10 * 60_000)).toEqual({ ok: false });
  });

  it('rejects a provider mismatch (cookie bound to one provider)', () => {
    const { stateParam, cookieValue } = createOAuthState('google', '/app', 1000);
    expect(verifyOAuthState(cookieValue, 'github', stateParam, 2000)).toEqual({ ok: false });
  });

  it('rejects a state mismatch and a missing cookie', () => {
    const { cookieValue } = createOAuthState('google', '/app', 1000);
    expect(verifyOAuthState(cookieValue, 'google', 'deadbeef'.repeat(8), 2000)).toEqual({ ok: false });
    expect(verifyOAuthState(undefined, 'google', 'anything', 2000)).toEqual({ ok: false });
  });

  it('rejects garbage / tampered cookie values', () => {
    expect(verifyOAuthState('not-a-cookie', 'google', 'x', 2000)).toEqual({ ok: false });
    // Valid base64 but nonsense JSON payload.
    expect(verifyOAuthState(btoa('{"p":"github"}'), 'github', 'x', 2000)).toEqual({ ok: false });
  });

  it('sanitizes the preserved next to /app paths only', () => {
    const evil = createOAuthState('google', 'https://evil.example', 1000);
    expect(verifyOAuthState(evil.cookieValue, 'google', evil.stateParam, 2000)).toEqual({ ok: true, next: '/app' });
  });
});

// -------------------------------------------------------------- providers

describe('provider normalizers', () => {
  it('google: sub + verified email', () => {
    expect(normalizeGoogleProfile({ sub: 'g-sub-1', email: 'User@Example.com', email_verified: true })).toEqual({
      provider: 'google',
      providerUserId: 'g-sub-1',
      email: 'User@Example.com',
      emailVerified: true,
    });
  });

  it('google: unverified flag is honored; missing sub throws', () => {
    expect(normalizeGoogleProfile({ sub: 'g-sub-1', email: 'a@b.c', email_verified: false }).emailVerified).toBe(false);
    expect(() => normalizeGoogleProfile({ email: 'a@b.c' })).toThrow();
    expect(() => normalizeGoogleProfile('nope')).toThrow();
  });

  it('github: prefers the primary verified email', () => {
    const p = normalizeGithubProfile(
      { id: 42, login: 'octo', email: null },
      [{ email: 'first@x.com', primary: false, verified: true }, { email: 'primary@x.com', primary: true, verified: true }],
    );
    expect(p).toEqual({ provider: 'github', providerUserId: '42', email: 'primary@x.com', emailVerified: true });
  });

  it('github: falls back to any verified email, then to an UNVERIFIED one', () => {
    const anyVerified = normalizeGithubProfile({ id: 7 }, [{ email: 'a@x.com', primary: false, verified: false }, { email: 'v@x.com', primary: false, verified: true }]);
    expect(anyVerified).toEqual({ provider: 'github', providerUserId: '7', email: 'v@x.com', emailVerified: true });
    const unverified = normalizeGithubProfile({ id: 7 }, [{ email: 'a@x.com', primary: true, verified: false }]);
    expect(unverified).toEqual({ provider: 'github', providerUserId: '7', email: 'a@x.com', emailVerified: false });
  });

  it('github: /user email fallback is unverified; no email at all → null', () => {
    const fallback = normalizeGithubProfile({ id: 9, email: 'pub@x.com' }, null);
    expect(fallback).toEqual({ provider: 'github', providerUserId: '9', email: 'pub@x.com', emailVerified: false });
    const none = normalizeGithubProfile({ id: 9 }, []);
    expect(none).toEqual({ provider: 'github', providerUserId: '9', email: null, emailVerified: false });
    expect(() => normalizeGithubProfile({ login: 'octo' }, null)).toThrow();
  });
});

describe('buildAuthorizeUrl', () => {
  it('google: carries client_id, redirect_uri, code response type and the openid scopes', () => {
    const url = new URL(buildAuthorizeUrl('google', { clientId: 'cid', redirectUri: 'https://cb.example/cb', state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cb.example/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('github: read:user user:email scopes against the GitHub authorize endpoint', () => {
    const url = new URL(buildAuthorizeUrl('github', { clientId: 'cid', redirectUri: 'https://cb.example/cb', state: 's2' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
  });
});
