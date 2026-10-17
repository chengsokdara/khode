import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { portalApi } from '../../portal-api';
import { Button, Card, Field, Input, PageHeader, Spinner, toast, cn } from '../../components/ui';

/**
 * Device-flow approval (/app/device, RFC 8628 user step): a CLI/TUI (khode)
 * shows a short code, the signed-in user confirms here. Approving binds the
 * eventual personal API key to THIS account — the emphasis on "only approve
 * codes from your own terminal" is the whole security model.
 */
export function PortalDevice() {
  const initial = (new URLSearchParams(window.location.search).get('code') ?? '').toUpperCase();
  const [code, setCode] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);

  const info = useQuery({
    queryKey: ['portal-device', submitted],
    queryFn: () => portalApi.deviceInfo(submitted),
    enabled: submitted.length > 0,
    retry: false,
  });

  const act = useMutation({
    mutationFn: (action: 'approve' | 'deny') => portalApi.approveDevice(submitted, action),
    onSuccess: (r) => {
      toast(r.status === 'approved' ? 'Device approved — return to your terminal.' : 'Device denied.');
      void info.refetch();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Request failed', 'err'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (normalized.length !== 8) {
      toast('Enter the 8-character code from your terminal', 'err');
      return;
    }
    setSubmitted(`${normalized.slice(0, 4)}-${normalized.slice(4)}`);
  };

  const status = info.data?.status;
  const decided = status === 'approved' || status === 'denied' || status === 'consumed';

  return (
    <>
      <PageHeader title="Device sign-in" subtitle="Approve a terminal that is signing in to your account." />
      <Card className="mx-auto max-w-xl p-6">
        {!submitted ? (
          <form onSubmit={onSubmit}>
            <Field label="Device code" hint="Shown in your terminal (format ABCD-EFGH)">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                autoFocus
                className="font-mono tracking-widest"
              />
            </Field>
            <Button type="submit" className="mt-4 w-full">
              Check code
            </Button>
          </form>
        ) : info.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : info.isError ? (
          <div className="text-center">
            <p className="text-sm text-zinc-300">{info.error instanceof Error ? info.error.message : 'Lookup failed'}</p>
            <Button variant="outline" className="mt-4" onClick={() => { setSubmitted(''); setCode(''); }}>
              Enter a different code
            </Button>
          </div>
        ) : status === 'pending' ? (
          <>
            <div className="flex items-start gap-3">
              <MonitorSmartphone className="mt-0.5 h-5 w-5 text-emerald-400" />
              <div>
                <div className="text-[15px] font-medium text-zinc-100">
                  {info.data?.display_name || 'A terminal client'} wants to sign in
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Approving creates a personal API key for your account (<span className="text-zinc-400">{submitted}</span>) and
                  hands it to the waiting terminal. Its usage bills your prepaid balance.
                </p>
              </div>
            </div>
            <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300">
              Only approve a code you just generated in your own terminal — anyone holding the code can claim the key.
            </p>
            <div className="mt-5 flex gap-3">
              <Button className="flex-1" disabled={act.isPending} onClick={() => act.mutate('approve')}>
                {act.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : <ShieldCheck className="h-4 w-4" />}
                Approve
              </Button>
              <Button variant="outline" className="flex-1" disabled={act.isPending} onClick={() => act.mutate('deny')}>
                Deny
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <ShieldCheck className={cn('mx-auto h-8 w-8', status === 'approved' ? 'text-emerald-400' : 'text-zinc-500')} />
            <p className="mt-3 text-sm text-zinc-200">
              {status === 'approved'
                ? 'Approved — return to your terminal; sign-in finishes there.'
                : status === 'denied'
                  ? 'Denied — you can close this page.'
                  : 'This sign-in was already completed.'}
            </p>
            <Button variant="outline" className="mt-4" onClick={() => { setSubmitted(''); setCode(''); }}>
              Approve another device
            </Button>
          </div>
        )}
        {decided && info.data?.display_name ? (
          <p className="mt-4 text-center text-[11px] text-zinc-600">for {info.data.display_name}</p>
        ) : null}
      </Card>
    </>
  );
}
