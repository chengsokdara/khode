// Cloudflare Turnstile on portal signup and login. Inactive until both
// TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set on the worker, so
// local dev and existing deploys keep working. When both are set, email
// signup and login refuse a missing or failed token.
import type { Env } from './env';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Both keys must be present. A site key alone cannot be checked server-side. */
export function turnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** The public half the login page needs to render the widget. */
export function turnstileSiteKey(env: Env): string | null {
  return turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY! : null;
}

/**
 * Checks a Turnstile token. Returns null when the check is off or the
 * token is valid, otherwise a message safe to show the user. fetchImpl
 * is injectable so tests do not call Cloudflare.
 */
export async function turnstileFailure(
  env: Env,
  token: unknown,
  ip: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!turnstileEnabled(env)) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return 'Complete the captcha and try again.';
  }
  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY!);
  body.set('response', token);
  if (ip && ip !== 'local') body.set('remoteip', ip);
  let res: Response;
  try {
    res = await fetchImpl(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return 'Captcha check failed — try again.';
  }
  if (!res.ok) return 'Captcha check failed — try again.';
  let data: { success?: boolean };
  try {
    data = (await res.json()) as { success?: boolean };
  } catch {
    return 'Captcha check failed — try again.';
  }
  return data.success === true ? null : 'Captcha check failed — try again.';
}
