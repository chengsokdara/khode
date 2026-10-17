import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/env';
import { turnstileEnabled, turnstileFailure, turnstileSiteKey } from '../../src/worker/turnstile';

const env = (over: Partial<Env> = {}): Env => ({ ENCRYPTION_KEY: 'x', ADMIN_PASSWORD: 'y', ...over }) as Env;

describe('turnstile', () => {
  it('stays off unless both keys are set', () => {
    expect(turnstileEnabled(env())).toBe(false);
    expect(turnstileEnabled(env({ TURNSTILE_SITE_KEY: 'site' }))).toBe(false);
    expect(turnstileEnabled(env({ TURNSTILE_SECRET_KEY: 'secret' }))).toBe(false);
    const on = env({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
    expect(turnstileEnabled(on)).toBe(true);
    expect(turnstileSiteKey(on)).toBe('site');
    expect(turnstileSiteKey(env())).toBeNull();
  });

  it('skips the check when disabled, and trusts siteverify when enabled', async () => {
    expect(await turnstileFailure(env(), undefined, 'local')).toBeNull();

    const on = env({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
    expect(await turnstileFailure(on, '', '1.2.3.4')).toMatch(/captcha/i);

    const ok = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
    expect(await turnstileFailure(on, 'tok', '1.2.3.4', ok as typeof fetch)).toBeNull();

    const bad = async () => new Response(JSON.stringify({ success: false }), { status: 200 });
    expect(await turnstileFailure(on, 'tok', 'local', bad as typeof fetch)).toMatch(/captcha/i);
  });
});
