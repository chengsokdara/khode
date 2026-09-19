import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Button, Field, Input, Logo, Spinner } from '../components/ui';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter the admin password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      navigate('/');
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
            <p className="mt-1 text-xs text-zinc-500">One base URL for every model</p>
          </div>
        </div>
        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-2xl shadow-black/50"
        >
          <Field label="Admin password">
            <Input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </Field>
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
          <Button type="submit" className="mt-4 w-full" disabled={busy}>
            {busy ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-[11px] text-zinc-600">
          Set <code className="text-zinc-500">ADMIN_PASSWORD</code> in <code className="text-zinc-500">khateway/.dev.vars</code>
        </p>
      </div>
    </div>
  );
}
