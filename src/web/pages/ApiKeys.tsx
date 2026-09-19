import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type ApiKey } from '../api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  toast,
} from '../components/ui';

function copyText(text: string) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast('Copied to clipboard'))
    .catch(() => toast('Copy failed — select the text manually', 'err'));
}

function fmtDate(ts: number | null): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ snippets

function snippetBlocks(key: string): { label: string; code: string }[] {
  const base = `${window.location.origin}/v1`;
  return [
    {
      label: 'OpenAI SDK — chat completions',
      code: `from openai import OpenAI\nclient = OpenAI(base_url="${base}", api_key="${key}")\n\nr = client.chat.completions.create(\n    model="your-model-slug",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(r.choices[0].message.content)`,
    },
    {
      label: 'OpenAI SDK — responses',
      code: `from openai import OpenAI\nclient = OpenAI(base_url="${base}", api_key="${key}")\n\nr = client.responses.create(model="your-model-slug", input="Hello!")\nprint(r.output_text)`,
    },
    {
      label: 'Anthropic SDK — messages',
      code: `from anthropic import Anthropic\nclient = Anthropic(base_url="${base}", api_key="${key}")\n\nr = client.messages.create(\n    model="your-model-slug",\n    max_tokens=256,\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(r.content[0].text)`,
    },
    {
      label: 'curl — chat completions',
      code: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "your-model-slug", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    },
  ];
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 pr-10 text-[11px] leading-relaxed text-zinc-300">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => copyText(code)}
        title="Copy"
        className="absolute top-2 right-2 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ forms

type KeyFormState = { name: string; spend_limit: string; rate_limit_rpm: string; cache_enabled: boolean; allowed: string[]; enabled: boolean };

function KeyModal({
  initial,
  models,
  onClose,
  onCreated,
}: {
  initial: ApiKey | null;
  models: string[];
  onClose: () => void;
  onCreated: (k: ApiKey) => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!initial;
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<KeyFormState>(() =>
    initial
      ? {
          name: initial.name,
          spend_limit: initial.spend_limit_usd != null ? String(initial.spend_limit_usd) : '',
          rate_limit_rpm: initial.rate_limit_rpm != null ? String(initial.rate_limit_rpm) : '',
          cache_enabled: initial.cache_enabled,
          allowed: initial.allowed_models,
          enabled: initial.enabled,
        }
      : { name: '', spend_limit: '', rate_limit_rpm: '', cache_enabled: false, allowed: [], enabled: true },
  );

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      isEdit ? api.updateApiKey(initial!.id, payload) : api.createApiKey(payload),
    onSuccess: (k) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      if (isEdit) {
        toast('API key updated');
        onClose();
      } else {
        onCreated(k); // reveal the raw key exactly once
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = form.name.trim();
    if (!name) return setError('Name is required — label the key by client/project');
    let limit: number | null = null;
    if (form.spend_limit.trim()) {
      limit = Number(form.spend_limit);
      if (!Number.isFinite(limit) || limit < 0) return setError('Spend limit must be a number ≥ 0 (USD)');
    }
    let rpm: number | null = null;
    if (form.rate_limit_rpm.trim()) {
      rpm = Number(form.rate_limit_rpm);
      if (!Number.isInteger(rpm) || rpm < 1) return setError('Rate limit must be an integer ≥ 1 request/minute');
    }
    const payload: Record<string, unknown> = {
      name,
      spend_limit_usd: limit,
      rate_limit_rpm: rpm,
      cache_enabled: form.cache_enabled,
      allowed_models: form.allowed.length ? form.allowed : null,
      enabled: form.enabled,
    };
    save.mutate(payload);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit API key — ${initial!.name}` : 'Create API key'}
      description={isEdit ? undefined : 'The raw key is shown once after creation — store it somewhere safe.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="key-form" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create key'}
          </Button>
        </>
      }
    >
      <form id="key-form" onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="e.g. termagent, laptop-openai-sdk">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="my-app" autoFocus={!isEdit} />
        </Field>

        <Field label="Spend limit (USD)" hint="Optional — requests are refused with 429 once accrued cost reaches this">
          <Input type="number" min={0} step="0.0001" value={form.spend_limit} onChange={(e) => setForm((f) => ({ ...f, spend_limit: e.target.value }))} placeholder="no limit" />
        </Field>

        <Field label="Rate limit (requests/minute)" hint="Optional override of the deployment default — 429 + Retry-After once exceeded">
          <Input type="number" min={1} value={form.rate_limit_rpm} onChange={(e) => setForm((f) => ({ ...f, rate_limit_rpm: e.target.value }))} placeholder="default" />
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 text-xs text-zinc-300">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-emerald-500"
            checked={form.cache_enabled}
            onChange={(e) => setForm((f) => ({ ...f, cache_enabled: e.target.checked }))}
          />
          <span>
            Semantic cache
            <span className="block text-[11px] leading-relaxed text-zinc-500">
              Serve repeat text-only requests from cache (master switch + lifetime live in Settings) for every
              model this key calls. Cached responses still log and debit.
            </span>
          </span>
        </label>

        <Field label="Allowed models" hint="Optional — empty means every model. Requests for other models get 403.">
          {models.length === 0 ? (
            <p className="text-xs text-zinc-500">No models registered — the key will serve whatever exists.</p>
          ) : (
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              {models.map((slug) => {
                const checked = form.allowed.includes(slug);
                return (
                  <label key={slug} className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-emerald-500"
                      checked={checked}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          allowed: checked ? f.allowed.filter((x) => x !== slug) : [...f.allowed, slug],
                        }))
                      }
                    />
                    <span className="font-mono">{slug}</span>
                  </label>
                );
              })}
            </div>
          )}
        </Field>

        <div className="flex items-center gap-2">
          <Switch checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
          <span className="text-[13px] text-zinc-400">Enabled</span>
        </div>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </form>
    </Modal>
  );
}

function KeyRevealedModal({ created, onClose }: { created: ApiKey; onClose: () => void }) {
  const snippets = useMemo(() => snippetBlocks(created.key ?? ''), [created.key]);
  return (
    <Modal
      open
      onClose={onClose}
      title="API key created"
      description="Copy it now — Khateway stores only a hash and this is the last time the full key is shown."
      width="lg"
      footer={
        <Button onClick={onClose}>
          <Check className="h-4 w-4" />
          I've stored the key
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <code className="flex-1 font-mono text-sm text-emerald-300 select-all">{created.key}</code>
          <Button variant="outline" size="sm" onClick={() => copyText(created.key ?? '')}>
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-medium text-zinc-400">Point a client at Khateway</h3>
          <div className="space-y-3">
            {snippets.map((s) => (
              <div key={s.label}>
                <div className="mb-1 text-[11px] text-zinc-500">{s.label}</div>
                <CodeBlock code={s.code} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SnippetsCard() {
  const snippets = useMemo(() => snippetBlocks('khat-your-key'), []);
  return (
    <Card className="mt-6 p-5">
      <h2 className="text-sm font-medium text-zinc-300">Connecting clients</h2>
      <p className="mt-1 mb-4 text-xs text-zinc-500">
        Any OpenAI or Anthropic SDK works — set the base URL to your Khateway deployment. With client-key
        enforcement off, clients can omit the key entirely (or send any placeholder — it is treated as anonymous).
        Otherwise use a client key (OpenAI SDKs: <code className="text-zinc-400">api_key</code>; Anthropic SDKs:{' '}
        <code className="text-zinc-400">api_key</code> — sent as <code className="text-zinc-400">x-api-key</code>, which
        Khateway also accepts).
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {snippets.map((s) => (
          <div key={s.label}>
            <div className="mb-1 text-[11px] text-zinc-500">{s.label}</div>
            <CodeBlock code={s.code} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ page

/** Deployment-wide auth-mode card: keyless-native default vs enforced client keys. */
function EnforcementCard() {
  const qc = useQueryClient();
  const sq = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const enforced = sq.data?.client_key_enforcement === 'on';

  const toggle = useMutation({
    mutationFn: (on: boolean) => api.updateSettings({ client_key_enforcement: on ? 'on' : 'off' }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast(s.client_key_enforcement === 'on' ? 'Client-key enforcement enabled' : 'Keyless access enabled');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });

  return (
    <Card className="mb-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">Client-key enforcement</h2>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">
            {enforced ? (
              <>
                <span className="font-medium text-zinc-300">On —</span> every /v1 request needs a valid client key (khode
                users set <code className="text-zinc-400">KHATEWAY_API_KEY</code>). Requests without one get 401.
              </>
            ) : (
              <>
                <span className="font-medium text-zinc-300">Off (default) —</span> keyless-native: clients can chat
                without a key (khode's “anonymous” mode just works). Enrolled keys still get their spend caps,
                allow-lists and log attribution.
              </>
            )}
          </p>
        </div>
        <Switch checked={enforced} disabled={sq.isLoading || toggle.isPending} onChange={(v) => toggle.mutate(v)} />
      </div>
    </Card>
  );
}

export function ApiKeys() {
  const qc = useQueryClient();
  const kq = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const mq = useQuery({ queryKey: ['models', ''], queryFn: () => api.models(undefined) });
  const sq = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const sqData = sq.data;

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null | undefined>(undefined);
  const [created, setCreated] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);

  const toggle = useMutation({
    mutationFn: (k: ApiKey) => api.updateApiKey(k.id, { enabled: !k.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast('API key deleted');
      setDeleting(null);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  const keys = kq.data ?? [];
  const enforced = sqData?.client_key_enforcement === 'on';
  const modelSlugs = (mq.data ?? []).map((m) => m.slug);

  const actionBtns = (children: ReactNode) => <div className="inline-flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">{children}</div>;

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="Client credentials for the /v1 gateway — hashed at rest, spend-capped, model-scoped."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Create key
          </Button>
        }
      />

      <EnforcementCard />

      {kq.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound className="h-8 w-8" />}
            title="No API keys yet"
            description={
              enforced
                ? 'Enforcement is on — create a key, then point any OpenAI or Anthropic SDK at this deployment with it.'
                : 'Clients can already use the gateway without a key. Create one anyway to cap spend or restrict models.'
            }
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Create your first key
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Key</th>
                  <th className="px-4 py-2.5 font-medium">Spend</th>
                  <th className="px-4 py-2.5 font-medium">Allowed models</th>
                  <th className="px-4 py-2.5 font-medium">Requests</th>
                  <th className="px-4 py-2.5 font-medium">Last used</th>
                  <th className="px-4 py-2.5 font-medium">Enabled</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {keys.map((k) => (
                  <tr key={k.id} className="group transition-colors hover:bg-zinc-900/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">{k.name}</span>
                        {!k.enabled ? <Badge tone="warn">disabled</Badge> : null}
                      </div>
                      <code className="mt-0.5 block font-mono text-[11px] text-zinc-500">{k.key_prefix}…</code>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                      ${k.spent_usd.toFixed(k.spent_usd > 0 && k.spent_usd < 0.01 ? 6 : 2)}
                      {k.spend_limit_usd != null ? <span className="text-zinc-600"> / ${k.spend_limit_usd}</span> : null}
                      {k.rate_limit_rpm != null ? <div className="text-[11px] text-zinc-600">{k.rate_limit_rpm} req/min</div> : null}
                      {k.cache_enabled ? <div className="text-[11px] text-emerald-500/80">cache on</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {k.allowed_models.length === 0 ? (
                        <Badge>all</Badge>
                      ) : (
                        <div className="flex max-w-56 flex-wrap gap-1">
                          {k.allowed_models.slice(0, 2).map((m) => (
                            <Badge key={m} title={m}>
                              {m}
                            </Badge>
                          ))}
                          {k.allowed_models.length > 2 ? <Badge>+{k.allowed_models.length - 2}</Badge> : null}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{k.request_count}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{fmtDate(k.last_used_at)}</td>
                    <td className="px-4 py-3">
                      <Switch checked={k.enabled} onChange={() => toggle.mutate(k)} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {actionBtns(
                        <>
                          <Button variant="ghost" size="icon" title="Edit key" onClick={() => setEditing(k)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" title="Delete key" onClick={() => setDeleting(k)}>
                            <Trash2 className="h-3.5 w-3.5 text-red-300" />
                          </Button>
                        </>,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <SnippetsCard />

      {creating ? (
        <KeyModal initial={null} models={modelSlugs} onClose={() => setCreating(false)} onCreated={setCreated} />
      ) : null}
      {editing !== undefined ? (
        <KeyModal initial={editing} models={modelSlugs} onClose={() => setEditing(undefined)} onCreated={setCreated} />
      ) : null}
      {created?.key ? <KeyRevealedModal created={created} onClose={() => setCreated(null)} /> : null}

      <ConfirmDialog
        open={!!deleting}
        title="Delete API key"
        body={`Delete key "${deleting?.name}" (${deleting?.key_prefix}…)? Clients using it will immediately receive 401s. Its request history stays in the logs.`}
        busy={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
