import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, CreditCard, KeyRound, Wallet } from 'lucide-react';
import { portalApi, type PortalUsageRow } from '../../portal-api';
import { Button, Card, EmptyState, Field, Input, PageHeader, Spinner, toast, fmtPrice, fmtTokens, cn } from '../../components/ui';

const TOPUP_PRESETS = [5, 10, 25, 50];

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => portalApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
      toast('Password changed');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Change failed'),
  });

  const valid = next.length >= 8 && next === confirm;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
        <KeyRound className="h-4 w-4" />
        Change password
      </div>
      <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
        Your current password is required — a stolen browser session alone cannot change it.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Current password">
          <Input
            type="password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setError(null);
            }}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <Input
            type="password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setError(null);
            }}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Repeat new password">
          <Input
            type="password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            autoComplete="new-password"
          />
        </Field>
      </div>
      {next.length > 0 && confirm.length > 0 && next !== confirm ? (
        <p className="mt-2 text-xs text-amber-400">New passwords don't match.</p>
      ) : error ? (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button onClick={() => change.mutate()} disabled={!valid || change.isPending}>
          {change.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
          Change password
        </Button>
      </div>
    </Card>
  );
}

function UsageTable({ rows }: { rows: PortalUsageRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No requests yet" description="Calls your keys make to /v1 show up here with tokens and cost." />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11px] tracking-wide text-zinc-500 uppercase">
          <tr>
            <th className="px-4 py-2.5 font-medium">When</th>
            <th className="px-4 py-2.5 font-medium">Model</th>
            <th className="px-4 py-2.5 font-medium">API</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Tokens (in/out)</th>
            <th className="px-4 py-2.5 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-800/70">
              <td className="px-4 py-2.5 whitespace-nowrap text-zinc-400">{fmtWhen(r.created_at)}</td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-zinc-200">{r.model_slug}</td>
              <td className="px-4 py-2.5 text-zinc-400">{r.dialect}</td>
              <td className="px-4 py-2.5">
                <span className={cn('font-mono text-[12px]', r.status < 400 ? 'text-emerald-400' : r.status < 500 ? 'text-amber-400' : 'text-red-400')}>
                  {r.status}
                </span>
              </td>
              <td className="px-4 py-2.5 text-zinc-400">
                {fmtTokens(r.tokens_in)} / {fmtTokens(r.tokens_out)}
              </td>
              <td className="px-4 py-2.5 text-right text-zinc-300">{r.cost_usd == null ? '—' : fmtPrice(r.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PortalDashboard() {
  const qc = useQueryClient();
  const [toppingUp, setToppingUp] = useState<number | null>(null);

  const me = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.me });
  const billing = useQuery({ queryKey: ['portal-billing'], queryFn: portalApi.billing });
  const usage = useQuery({ queryKey: ['portal-usage'], queryFn: () => portalApi.usage(25) });

  // Landing back from the Lemon Squeezy hosted checkout.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('topup') === 'success') {
      toast('Payment received — your balance updates as soon as the webhook lands.');
      window.history.replaceState({}, '', '/app');
    }
  }, []);

  const checkout = useMutation({
    mutationFn: (amount: number) => portalApi.createCheckout(amount),
    onMutate: (amount) => setToppingUp(amount),
    onSuccess: (res) => {
      window.location.href = res.url;
    },
    onError: (e) => {
      toast(e instanceof Error ? e.message : 'Checkout failed', 'err');
      setToppingUp(null);
    },
  });

  if (me.isLoading || billing.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!me.data) return null;

  const user = me.data.user;
  const entries = billing.data?.entries ?? [];
  const balance = billing.data?.balance_usd ?? user.balance_usd;

  return (
    <>
      <PageHeader title="Overview" subtitle={`Account ${user.email}`} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-1">
          <div className="flex items-center gap-2 text-[13px] text-zinc-400">
            <Wallet className="h-4 w-4" />
            Prepaid balance
          </div>
          <div className={cn('mt-3 text-3xl font-semibold tracking-tight', balance > 0 ? 'text-emerald-400' : 'text-zinc-300')}>
            {fmtPrice(balance)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Gateway requests draw this down per token. Keys stop working at $0.
          </p>
          {me.data.billing_configured ? (
            <div className="mt-5">
              <div className="text-xs font-medium text-zinc-400">Top up</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {TOPUP_PRESETS.map((amount) => (
                  <Button
                    key={amount}
                    size="sm"
                    variant={amount === 10 ? 'primary' : 'outline'}
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate(amount)}
                  >
                    {toppingUp === amount ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : <CreditCard className="h-3.5 w-3.5" />}
                    ${amount}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">Secure checkout + invoicing by our merchant of record.</p>
            </div>
          ) : (
            <p className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[11px] text-zinc-500">
              Card top-ups are not enabled yet — ask the administrator, or use an admin-granted credit.
            </p>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <div className="border-b border-zinc-800/70 px-5 py-4 text-[13px] font-medium text-zinc-200">Balance history</div>
          {entries.length === 0 ? (
            <EmptyState icon={<Wallet className="h-6 w-6" />} title="No balance activity yet" description="Top-ups and per-request charges appear here." />
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-[13px]">
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-t border-zinc-800/70 first:border-t-0">
                      <td className="px-5 py-2.5 whitespace-nowrap text-zinc-500">{fmtWhen(e.created_at)}</td>
                      <td className="px-5 py-2.5">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
                            e.kind === 'topup'
                              ? 'bg-emerald-500/10 text-emerald-300'
                              : e.kind === 'usage'
                                ? 'bg-zinc-800 text-zinc-400'
                                : 'bg-sky-500/10 text-sky-300',
                          )}
                        >
                          {e.delta_usd >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {e.kind}
                        </span>
                      </td>
                      <td className="max-w-0 truncate px-5 py-2.5 text-zinc-500">{e.note ?? ''}</td>
                      <td className={cn('px-5 py-2.5 text-right font-mono text-[12px]', e.delta_usd >= 0 ? 'text-emerald-400' : 'text-zinc-300')}>
                        {e.delta_usd >= 0 ? '+' : ''}
                        {e.delta_usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {user.has_password ? (
        <div className="mt-4">
          <ChangePasswordCard />
        </div>
      ) : null}

      <div className="mt-4">
        <Card>
          <div className="flex items-center justify-between border-b border-zinc-800/70 px-5 py-4">
            <span className="text-[13px] font-medium text-zinc-200">Recent requests</span>
            <button
              className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['portal-usage'] });
                void qc.invalidateQueries({ queryKey: ['portal-billing'] });
                void qc.invalidateQueries({ queryKey: ['portal-me'] });
              }}
            >
              Refresh
            </button>
          </div>
          {usage.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <UsageTable rows={usage.data ?? []} />
          )}
        </Card>
      </div>
    </>
  );
}
