import { useEffect, useRef, useState, type FormEvent } from 'react';
import { portalApi } from '../../portal-api';
import { navigate } from '../../router';
import { Button, Field, Input, Logo, Spinner } from '../../components/ui';
import { cn } from '../../components/ui';

/** Portal auth: social sign-in (Google/GitHub — backend-driven 302s) on top,
 * email/password as the fallback below. A `?next=` param (set by the portal
 * guard or an OAuth failure redirect) returns the user to where they were
 * headed — e.g. a device verification link; `?error=` carries a message back
 * from the OAuth callback. */
export function PortalLogin() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get('error'));
  const [busy, setBusy] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const urlParams = new URLSearchParams(window.location.search);
  const nextRaw = urlParams.get('next') ?? '';
  const next = nextRaw.startsWith('/app') && !nextRaw.startsWith('/app/login') ? nextRaw : '/app';

  useEffect(() => {
    let cancelled = false;
    portalApi
      .turnstile()
      .then((cfg) => {
        if (!cancelled && cfg.enabled && cfg.siteKey) setSiteKey(cfg.siteKey);
      })
      .catch(() => {
        // No widget when the config call fails: the server still accepts
        // the form while Turnstile is off, and refuses it when it is on.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The social buttons leave the SPA for a backend route that 302s to the
  // provider; the callback mints the session cookie and lands back on `next`.
  const socialStart = (provider: 'google' | 'github') => {
    window.location.href = `/api/portal/oauth/${provider}/start?next=${encodeURIComponent(next)}`;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError(mode === 'signup' ? 'Enter an email and a password (8+ characters)' : 'Enter your email and password');
      return;
    }
    if (siteKey && !turnstileToken) {
      setError('Complete the captcha and try again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') await portalApi.signup(email, password, turnstileToken);
      else await portalApi.login(email, password, turnstileToken);
      navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Logo size={44} />
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Khateway</h1>
            <p className="mt-1 text-xs text-zinc-500">One API for every model</p>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-2xl shadow-black/50">
          <div className="grid gap-2">
            <Button variant="outline" className="w-full" onClick={() => socialStart('google')}>
              Continue with Google
            </Button>
            <Button variant="outline" className="w-full" onClick={() => socialStart('github')}>
              Continue with GitHub
            </Button>
          </div>
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-800" />
            <span className="text-[11px] text-zinc-600">or continue with email</span>
            <div className="h-px flex-1 bg-zinc-800" />
          </div>
          <div className="mb-5 grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1 text-[13px]">
            {(['login', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium transition-colors',
                  mode === m ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>
          <form onSubmit={onSubmit}>
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
              />
            </Field>
            <div className="mt-3">
              <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder="••••••••"
                />
              </Field>
            </div>
            {siteKey ? <TurnstileField siteKey={siteKey} onToken={setTurnstileToken} /> : null}
            {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
              {mode === 'signup' ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-[11px] text-zinc-600">
          Keys and usage for the gateway at <code className="text-zinc-500">/v1</code>
        </p>
      </div>
    </div>
  );
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

/** Explicit Turnstile widget. The token is cleared when it expires. */
function TurnstileField({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    const render = () => {
      const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (cancelled || !host.current || !ts || widget.current) return;
      widget.current = ts.render(host.current, {
        sitekey: siteKey,
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current(''),
      });
    };
    const ts = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (ts) render();
    else if (!document.querySelector('script[data-khateway-turnstile]')) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.dataset.khatewayTurnstile = '1';
      script.onload = render;
      document.head.appendChild(script);
    } else {
      const script = document.querySelector('script[data-khateway-turnstile]');
      script?.addEventListener('load', render);
    }
    return () => {
      cancelled = true;
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (widget.current && api) api.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  return <div ref={host} className="mt-3" />;
}
