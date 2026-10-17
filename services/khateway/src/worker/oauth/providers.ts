// Google + GitHub OAuth 2.0 authorization-code faces, hand-rolled with fetch
// (no SDKs — deliberate). Two halves: PURE helpers (authorize-URL builders and
// profile normalizers — offline-tested in tests/worker/oauth.test.ts) and thin
// authenticated fetches (token exchange + profile download) that throw
// OAuthProviderError on anything unexpected. The route layer never talks to
// provider-specific shapes: it consumes OAuthProfile and URLs only.
import type { OAuthProvider } from './config';

export interface OAuthProviderDescriptor {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export const OAUTH_PROVIDER_DESCRIPTORS: Record<OAuthProvider, OAuthProviderDescriptor> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
};

/** Normalized identity returned by a provider. `providerUserId` is the STABLE
 * provider-side id (Google `sub` / GitHub numeric id) — linking keys on it,
 * never on the email or login (both mutable). */
export interface OAuthProfile {
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
}

export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}

const FETCH_TIMEOUT_MS = 10_000;

/** Pure: the redirect target for /oauth/:provider/start. `state` is the random
 * value also stored in the state cookie; `next` never rides the URL. */
export function buildAuthorizeUrl(provider: OAuthProvider, opts: { clientId: string; redirectUri: string; state: string }): string {
  const d = OAUTH_PROVIDER_DESCRIPTORS[provider];
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: d.scope,
    state: opts.state,
  });
  return `${d.authorizeUrl}?${params.toString()}`;
}

// ------------------------------------------------------------- normalizers

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Google emits a JSON boolean; accept its string forms too. */
function truthy(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Pure: Google v3 userinfo payload → OAuthProfile. Throws when the payload
 * lacks `sub` (the stable id) — that response can never identify a user. */
export function normalizeGoogleProfile(json: unknown): OAuthProfile {
  const rec = asRecord(json);
  if (!rec) throw new OAuthProviderError('Google profile is missing the subject id');
  const sub = asString(rec.sub);
  if (!sub) throw new OAuthProviderError('Google profile is missing the subject id');
  return {
    provider: 'google',
    providerUserId: sub,
    email: asString(rec.email),
    // Google only returns verified addresses on the userinfo scopes we ask for.
    emailVerified: truthy(rec.email_verified),
  };
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

function parseGithubEmails(json: unknown): GithubEmail[] {
  if (!Array.isArray(json)) return [];
  const out: GithubEmail[] = [];
  for (const entry of json) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const email = asString(rec.email);
    if (!email) continue;
    out.push({ email, primary: rec.primary === true, verified: rec.verified === true });
  }
  return out;
}

/** Pure: GitHub /user + /user/emails payloads → OAuthProfile. Email selection:
 * primary+verified, else any verified, else primary/first (UNVERIFIED — the
 * decision layer must never link on it), else the /user email (also treated
 * unverified). No address at all → email null (new-account path only). */
export function normalizeGithubProfile(userJson: unknown, emailsJson: unknown): OAuthProfile {
  const user = asRecord(userJson);
  if (!user) throw new OAuthProviderError('GitHub profile is missing the user id');
  const rawId = user.id;
  const id = typeof rawId === 'number' && Number.isInteger(rawId) ? String(rawId) : asString(rawId);
  if (!id) throw new OAuthProviderError('GitHub profile is missing the user id');

  const emails = parseGithubEmails(emailsJson);
  const primary = emails.find((e) => e.primary) ?? null;
  const firstVerified = emails.find((e) => e.verified) ?? null;
  const first = emails[0] ?? null;
  let chosen: GithubEmail | null = null;
  let chosenVerified = false;
  if (primary && primary.verified) {
    chosen = primary;
    chosenVerified = true;
  } else if (firstVerified) {
    chosen = firstVerified;
    chosenVerified = true;
  } else {
    chosen = primary ?? first;
  }
  return {
    provider: 'github',
    providerUserId: id,
    email: chosen?.email ?? asString(user.email),
    emailVerified: chosenVerified,
  };
}

// ---------------------------------------------------------- auth fetches

async function parseJsonObject(res: Response): Promise<Record<string, unknown>> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new OAuthProviderError(`${res.url ? new URL(res.url).host : 'provider'} returned a non-JSON response`);
  }
  const rec = asRecord(json);
  if (!rec) throw new OAuthProviderError('Provider returned an unexpected response shape');
  return rec;
}

async function assertOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new OAuthProviderError(`${what} failed (HTTP ${res.status})`);
}

/** Exchanges the authorization code for an access token (form POST, per each
 * provider's spec — GitHub needs Accept: application/json or it answers
 * urlencoded). Returns the bare access token. */
export async function exchangeCodeForToken(
  provider: OAuthProvider,
  opts: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<string> {
  const d = OAUTH_PROVIDER_DESCRIPTORS[provider];
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(d.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': 'khateway',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, `${provider} token exchange`);
  const rec = await parseJsonObject(res);
  const token = asString(rec.access_token);
  if (!token) {
    const description = asString(rec.error_description) ?? asString(rec.error) ?? 'no access_token in response';
    throw new OAuthProviderError(`${provider} token exchange: ${description}`);
  }
  return token;
}

async function fetchJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      // GitHub API rejects unauthenticated-looking requests without a UA.
      'user-agent': 'khateway',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await assertOk(res, 'profile fetch');
  return res.json();
}

/** Downloads and normalizes the identity for the given access token. */
export async function fetchProviderProfile(provider: OAuthProvider, accessToken: string): Promise<OAuthProfile> {
  if (provider === 'google') {
    return normalizeGoogleProfile(await fetchJson('https://www.googleapis.com/oauth2/v3/userinfo', accessToken));
  }
  const [userJson, emailsJson] = await Promise.all([
    fetchJson('https://api.github.com/user', accessToken),
    fetchJson('https://api.github.com/user/emails', accessToken).catch(() => null), // scope downgrades must not kill sign-in
  ]);
  return normalizeGithubProfile(userJson, emailsJson);
}
