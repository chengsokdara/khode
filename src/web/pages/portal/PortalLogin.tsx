import { useState, type FormEvent } from 'react';
import { portalApi } from '../../portal-api';
import { navigate } from '../../router';
import { Button, Field, Input, Logo, Spinner } from '../../components/ui';
import { cn } from '../../components/ui';

/** Portal auth: sign in for existing accounts, create-account tab for signups. */
export function PortalLogin() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError(mode === 'signup' ? 'Enter an email and a password (8+ characters)' : 'Enter your email and password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') await portalApi.signup(email, password);
      else await portalApi.login(email, password);
      navigate('/app');
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
