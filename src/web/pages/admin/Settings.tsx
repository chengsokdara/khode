import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Database, Gauge, Globe } from 'lucide-react';
import { api } from '../../api';
import { Button, Card, Field, Input, PageHeader, Spinner, Switch, toast } from '../../components/ui';

function GatewayCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.settings });

  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.updateSettings(p),
    onSuccess: (s) => {
      qc.setQueryData(['admin-settings'], s);
      toast('Settings saved');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Save failed', 'err'),
  });

  if (settings.isLoading) {
    return (
      <Card className="flex justify-center py-10">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  if (!s) return null;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
        <Globe className="h-4 w-4" />
        Gateway & accounts
      </div>
      <div className="mt-5 space-y-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[13px] text-zinc-200">Client-key enforcement</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Off (default): the gateway serves anonymous traffic — the keyless-native behavior khode relies on.
              On: every /v1 call needs a valid <code className="text-zinc-400">khat-</code> key.
            </p>
          </div>
          <Switch checked={s.client_key_enforcement === 'on'} onChange={(v) => patch.mutate({ client_key_enforcement: v ? 'on' : 'off' })} disabled={patch.isPending} />
        </div>
        <div className="flex items-start justify-between gap-6 border-t border-zinc-800/70 pt-5">
          <div>
            <div className="text-[13px] text-zinc-200">Public signups</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              On (default): anyone can create a portal account at <code className="text-zinc-400">/app</code>.
              Off: only existing accounts can sign in — new signups are rejected.
            </p>
          </div>
          <Switch checked={s.public_signup === 'on'} onChange={(v) => patch.mutate({ public_signup: v ? 'on' : 'off' })} disabled={patch.isPending} />
        </div>
      </div>
    </Card>
  );
}

function BillingCard() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['admin-billing-config'], queryFn: api.billingConfig });
  const [storeId, setStoreId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    const c = config.data;
    if (c) {
      setStoreId(c.store_id ?? '');
      setVariantId(c.variant_id ?? '');
    }
  }, [config.data]);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updateBillingConfig(patch),
    onSuccess: (c) => {
      qc.setQueryData(['admin-billing-config'], c);
      setApiKey('');
      setWebhookSecret('');
      toast('Billing config saved');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Save failed', 'err'),
  });

  const c = config.data;
  const dirty = c ? storeId !== (c.store_id ?? '') || variantId !== (c.variant_id ?? '') : false;
  const webhookUrl = `${origin}/webhooks/lemonsqueezy`;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
        <CreditCard className="h-4 w-4" />
        Billing — Lemon Squeezy (merchant of record)
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Credit top-ups run through a Lemon Squeezy checkout; their webhook credits the buyer's balance.
        The webhook URL below must be registered in your Lemon Squeezy store settings with the same signing secret.
      </p>
      {config.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !c ? null : (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Store ID">
              <Input value={storeId} onChange={(e) => setStoreId(e.target.value)} placeholder="from Lemon Squeezy dashboard" />
            </Field>
            <Field label="Top-up variant ID">
              <Input value={variantId} onChange={(e) => setVariantId(e.target.value)} placeholder="the 'credit' product variant" />
            </Field>
            <Field label="API key" hint={c.api_key_hint ? `Saved — hint …${c.api_key_hint}. Enter a new value to replace.` : 'Required to create hosted checkouts.'}>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={c.api_key_hint ? '•••••••• (unchanged)' : 'paste API key'} />
            </Field>
            <Field label="Webhook signing secret" hint={c.webhook_secret_set ? 'Saved. Enter a new value to replace.' : 'Required to verify webhook signatures.'}>
              <Input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={c.webhook_secret_set ? '•••••••• (unchanged)' : 'paste signing secret'} />
            </Field>
          </div>
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
            <div className="text-[11px] text-zinc-500">Webhook URL (paste into Lemon Squeezy → Settings → Webhooks)</div>
            <code className="mt-0.5 block truncate font-mono text-[12px] text-zinc-300">{webhookUrl}</code>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-[11px] text-zinc-500">
              Status: {c.configured ? <span className="text-emerald-400">top-ups enabled</span> : <span className="text-amber-400">incomplete — checkouts disabled</span>}
              {!c.webhook_secret_set ? ' · webhook secret missing' : ''}
            </div>
            <Button
              onClick={() =>
                save.mutate({
                  store_id: storeId,
                  variant_id: variantId,
                  ...(apiKey ? { api_key: apiKey } : {}),
                  ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
                })
              }
              disabled={save.isPending || (!dirty && !apiKey && !webhookSecret)}
            >
              {save.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
              Save billing config
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function RateLimitCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.settings });
  const [keyRpm, setKeyRpm] = useState('');
  const [ipRpm, setIpRpm] = useState('');

  useEffect(() => {
    const s = settings.data;
    if (s) {
      setKeyRpm(String(s.rate_limit_key_rpm));
      setIpRpm(String(s.rate_limit_ip_rpm));
    }
  }, [settings.data]);

  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.updateSettings(p),
    onSuccess: (s) => {
      qc.setQueryData(['admin-settings'], s);
      toast('Settings saved');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Save failed', 'err'),
  });

  if (settings.isLoading) {
    return (
      <Card className="flex justify-center py-10">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  if (!s) return null;
  const rpmDirty = keyRpm !== String(s.rate_limit_key_rpm) || ipRpm !== String(s.rate_limit_ip_rpm);
  const rpmValid = Number.isInteger(Number(keyRpm)) && Number(keyRpm) >= 1 && Number.isInteger(Number(ipRpm)) && Number(ipRpm) >= 1;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
        <Gauge className="h-4 w-4" />
        Rate limiting
      </div>
      <div className="mt-5 space-y-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[13px] text-zinc-200">Enforce request-rate limits</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Fixed 1-minute windows counted across all isolates: per client key (or per IP for anonymous
              traffic), plus optional per-model caps on each model. Exceeding a limit answers 429 with
              <code className="text-zinc-400"> Retry-After</code>.
            </p>
          </div>
          <Switch checked={s.rate_limit_enabled === 'on'} onChange={(v) => patch.mutate({ rate_limit_enabled: v ? 'on' : 'off' })} disabled={patch.isPending} />
        </div>
        <div className="border-t border-zinc-800/70 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default per-key limit (req/min)" hint="Applies to keys without their own override">
              <Input type="number" min={1} value={keyRpm} onChange={(e) => setKeyRpm(e.target.value)} />
            </Field>
            <Field label="Per-IP limit (req/min)" hint="Anonymous (keyless) requests only">
              <Input type="number" min={1} value={ipRpm} onChange={(e) => setIpRpm(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => patch.mutate({ rate_limit_key_rpm: Number(keyRpm), rate_limit_ip_rpm: Number(ipRpm) })}
              disabled={patch.isPending || !rpmDirty || !rpmValid}
            >
              Save limits
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function CacheCard() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.settings });
  const stats = useQuery({ queryKey: ['admin-cache-stats'], queryFn: api.cacheStats });
  const [ttl, setTtl] = useState('');

  useEffect(() => {
    const s = settings.data;
    if (s) setTtl(String(s.cache_ttl_seconds));
  }, [settings.data]);

  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.updateSettings(p),
    onSuccess: (s) => {
      qc.setQueryData(['admin-settings'], s);
      toast('Settings saved');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Save failed', 'err'),
  });

  const flush = useMutation({
    mutationFn: api.flushCache,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin-cache-stats'] });
      toast(`Cache flushed — ${r.flushed} entr${r.flushed === 1 ? 'y' : 'ies'} removed`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Flush failed', 'err'),
  });

  if (settings.isLoading) {
    return (
      <Card className="flex justify-center py-10">
        <Spinner />
      </Card>
    );
  }
  const s = settings.data;
  if (!s) return null;
  const ttlValid = Number.isInteger(Number(ttl)) && Number(ttl) >= 1 && Number(ttl) <= 2592000;
  const st = stats.data;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-200">
        <Database className="h-4 w-4" />
        Semantic cache
      </div>
      <div className="mt-5 space-y-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[13px] text-zinc-200">Enable response cache</div>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Repeats of an identical text-only, non-streaming request are served from cache instead of the
              upstream. Off by default — turn it on per model (Models page) or per client key (API Keys page).
              Cached hits still log usage and debit balances.
            </p>
          </div>
          <Switch checked={s.cache_enabled === 'on'} onChange={(v) => patch.mutate({ cache_enabled: v ? 'on' : 'off' })} disabled={patch.isPending} />
        </div>
        <div className="border-t border-zinc-800/70 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Entry lifetime (seconds)" hint="1 second – 30 days; default 3600">
              <Input type="number" min={1} value={ttl} onChange={(e) => setTtl(e.target.value)} />
            </Field>
            <Field label="Cache contents" hint={st ? `${(st.bytes / 1024).toFixed(1)} KB stored` : undefined}>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[12px] text-zinc-300">
                {st ? (
                  <>
                    {st.entries} entr{st.entries === 1 ? 'y' : 'ies'} · {st.hits_24h} hits / 24 h ·{' '}
                    {st.tokens_cached_24h.toLocaleString()} cached tokens
                  </>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </div>
            </Field>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-[11px] text-zinc-500">Flush drops every cached response immediately; clients hit upstream again.</div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => flush.mutate()} disabled={flush.isPending || !st || st.entries === 0}>
                {flush.isPending ? <Spinner className="border-zinc-900/70 border-t-transparent" /> : null}
                Flush cache
              </Button>
              <Button
                onClick={() => patch.mutate({ cache_ttl_seconds: Number(ttl) })}
                disabled={patch.isPending || !ttlValid || Number(ttl) === s.cache_ttl_seconds}
              >
                Save lifetime
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Settings() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Deployment-wide gateway, account and billing configuration." />
      <div className="space-y-4">
        <GatewayCard />
        <RateLimitCard />
        <CacheCard />
        <BillingCard />
      </div>
    </>
  );
}
