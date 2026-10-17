// Social sign-in account linking — the security-critical half of OAuth.
//
// decideOAuthSignIn is PURE (offline-tested): given the provider profile and
// three lookup results, it picks exactly one action. applyOAuthSignInDecision
// is the thin D1 executor for the create/link actions. The invariant that
// matters: an identity row is the ONLY pre-existing link; an email match only
// links when the PROVIDER verified that email (never on a bare claim), and a
// create that collides with an existing email refuses instead of linking —
// otherwise an unverified GitHub email would be an account-takeover vector.
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { oauthIdentities, users } from '../db/schema';
import type { OAuthProfile } from '../oauth/providers';
import type { OAuthProvider } from '../oauth/config';

export type OAuthSignInDecision =
  | { action: 'sign_in'; userId: string }
  | { action: 'link'; userId: string }
  | { action: 'create' }
  | { action: 'refuse'; reason: 'user_disabled' | 'signup_disabled' | 'no_email' };

export interface OAuthSignInInput {
  profile: OAuthProfile;
  /** The (provider, provider_user_id) identity row already exists and points at this user. */
  identity: { userId: string; enabled: boolean } | null;
  /** A portal user whose email equals profile.email — the CALLER only passes
   * one when the provider verified the email; the decision also re-guards. */
  verifiedEmailMatch: { id: string; enabled: boolean } | null;
  /** The deployment's public_signup setting ('on' default). */
  signupAllowed: boolean;
}

/**
 * Link-or-create rules, in order:
 *  (a) identity exists → sign that user in (enabled accounts only);
 *  (b) provider-VERIFIED email matches an existing user → link the identity;
 *  (c) otherwise create a new account — only while public_signup allows.
 * An unverified email NEVER matches (rule (b) is unreachable for it, even if
 * a caller bugs up the input) and a missing email can only ever create.
 */
export function decideOAuthSignIn(input: OAuthSignInInput): OAuthSignInDecision {
  // (a) The identity row is proof of a previous sign-in with this provider id.
  if (input.identity) {
    return input.identity.enabled
      ? { action: 'sign_in', userId: input.identity.userId }
      : { action: 'refuse', reason: 'user_disabled' };
  }
  // (b) Defensive re-guard: linking demands BOTH a verified email claim AND
  // the lookup done on it. Unverified emails fall straight through to (c).
  if (input.profile.emailVerified && input.verifiedEmailMatch) {
    return input.verifiedEmailMatch.enabled
      ? { action: 'link', userId: input.verifiedEmailMatch.id }
      : { action: 'refuse', reason: 'user_disabled' };
  }
  // (c) Nothing to link onto — a new account, if the instance allows signups.
  if (!input.profile.email) return { action: 'refuse', reason: 'no_email' };
  return input.signupAllowed ? { action: 'create' } : { action: 'refuse', reason: 'signup_disabled' };
}

export type OAuthLinkOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'email_exists' | 'identity_conflict' | 'no_email' };

/** Inserts the identity row for an existing user. Unique (provider,
 * provider_user_id) is the concurrency backstop: a racing callback for the
 * same provider id re-selects and must agree on the user, else refuses. */
async function insertIdentity(env: Env, profile: OAuthProfile, userId: string): Promise<OAuthLinkOutcome> {
  const db = getDb(env);
  try {
    await db.insert(oauthIdentities).values({
      id: crypto.randomUUID(),
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      userId,
      email: profile.email,
      createdAt: Date.now(),
    });
    return { ok: true, userId };
  } catch {
    // Lost a race: the identity was created concurrently.
    const [row] = await db
      .select({ userId: oauthIdentities.userId })
      .from(oauthIdentities)
      .where(and(eq(oauthIdentities.provider, profile.provider), eq(oauthIdentities.providerUserId, profile.providerUserId)));
    return row && row.userId === userId ? { ok: true, userId } : { ok: false, reason: 'identity_conflict' };
  }
}

/** The decision the route acts on — `refuse` is answered before this runs. */
type ActionableDecision = Extract<OAuthSignInDecision, { action: 'sign_in' | 'link' | 'create' }>;

/** Executes the create/link/sign_in actions of a decision; the route mints
 * the portal session for the returned user id. */
export async function applyOAuthSignInDecision(env: Env, profile: OAuthProfile, decision: ActionableDecision): Promise<OAuthLinkOutcome> {
  if (decision.action === 'sign_in') return { ok: true, userId: decision.userId };
  if (decision.action === 'link') return insertIdentity(env, profile, decision.userId);

  // Create the account. email is unique — if our insert didn't land, an
  // account with this email already exists. REFUSE: linking onto it here
  // would trust whatever email claim got us into this branch (the dangerous
  // case is an unverified GitHub address matching a real account).
  const email = profile.email?.toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };
  const db = getDb(env);
  const now = Date.now();
  const rec = {
    id: crypto.randomUUID(),
    email,
    passwordHash: null, // OAuth-only account
    balanceUsdMicros: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(rec).onConflictDoNothing();
  const [created] = await db.select({ id: users.id }).from(users).where(eq(users.id, rec.id));
  if (!created) return { ok: false, reason: 'email_exists' };
  return insertIdentity(env, profile, rec.id);
}

/** The lookup half of the flow (route calls this, then decideOAuthSignIn). */
export async function findOAuthIdentity(
  env: Env,
  provider: OAuthProvider,
  providerUserId: string,
): Promise<{ userId: string; enabled: boolean } | null> {
  const [row] = await getDb(env)
    .select({ userId: oauthIdentities.userId, enabled: users.enabled })
    .from(oauthIdentities)
    .innerJoin(users, eq(users.id, oauthIdentities.userId))
    .where(and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.providerUserId, providerUserId)));
  return row ? { userId: row.userId, enabled: Boolean(row.enabled) } : null;
}

/** Email lookup for rule (b) — callers pass the result ONLY when the provider
 * verified the address. */
export async function findUserByEmail(env: Env, email: string): Promise<{ id: string; enabled: boolean } | null> {
  const [row] = await getDb(env).select({ id: users.id, enabled: users.enabled }).from(users).where(eq(users.email, email.toLowerCase()));
  return row ? { id: row.id, enabled: Boolean(row.enabled) } : null;
}
