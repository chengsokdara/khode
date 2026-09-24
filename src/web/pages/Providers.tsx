import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, PlugZap, Plus, Server, Trash2 } from 'lucide-react';
import {
  ADAPTER_DEFAULTS,
  ADAPTER_HINTS,
  ADAPTER_LABELS,
  api,
  type Adapter,
  type Provider,
  type TestResult,
} from '../api';
import { VENDOR_PRESETS, type VendorPreset } from '../../shared/vendor-urls';
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
  Textarea,
  toast,
} from '../components/ui';

type FormState = {
  name: string;
  adapters: Adapter[];
  base_url: string;
  api_key: string;
  default_headers: string;
  timeout_ms: string;
  enabled: boolean;
};

const ALL_ADAPTERS: Adapter[] = ['openai', 'anthropic', 'gemini'];

/** Builds the save payload shared by provider create and update. */
function formPayload(form: FormState): Record<string, unknown> {
  let headers: Record<string, string> | null = null;
  if (form.default_headers.trim()) {
    try {
      const parsed: unknown = JSON.parse(form.default_headers);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      const obj = parsed as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (!k.trim() || typeof v !== 'string') throw new Error('bad entry');
      }
      headers = obj as Record<string, string>;
    } catch {
      throw new Error('Default headers must be a JSON object with string values, e.g. {"X-Title": "Khateway"}');
    }
  }
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    adapters: form.adapters,
    base_url: form.base_url.trim() || null,
    default_headers: headers,
    timeout_ms: Number(form.timeout_ms) || 60000,
    enabled: form.enabled,
  };
  if (form.api_key.trim()) payload.api_key = form.api_key.trim();
  return payload;
}

function ProviderModal({ initial, onClose }: { initial: Provider | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!initial;
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() =>
    initial
      ? {
          name: initial.name,
          adapters: initial.adapters?.length ? initial.adapters : [initial.adapter],
          base_url: initial.base_url ?? '',
          api_key: '',
          default_headers: initial.default_headers ? JSON.stringify(initial.default_headers, null, 2) : '',
          timeout_ms: String(initial.timeout_ms ?? 60000),
          enabled: initial.enabled,
        }
      : {
          name: '',
          adapters: ['openai'],
          base_url: '',
          api_key: '',
          default_headers: '',
          timeout_ms: '60000',
          enabled: true,
        },
  );

  const toggleAdapter = (a: Adapter) =>
    setForm((f) => {
      const has = f.adapters.includes(a);
      const next = has ? f.adapters.filter((x) => x !== a) : [...f.adapters, a];
      return { ...f, adapters: next.length ? next : f.adapters }; // keep ≥1
    });

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // ---- base URL convenience ----------------------------------------------
  // Presets relevant to the current adapter selection: vendors serving at
  // least one selected adapter, vendors matching both first. Sorting keeps
  // the most common one-adapter vendors near their adapter.
  const relevantPresets = useMemo(() => {
    const matching = VENDOR_PRESETS.filter((p) => p.adapters.some((a) => form.adapters.includes(a)));
    return [...matching, ...VENDOR_PRESETS.filter((p) => !matching.includes(p))];
  }, [form.adapters]);

  const applyPreset = (p: VendorPreset) => {
    setForm((f) => ({ ...f, base_url: p.baseUrl, adapters: p.adapters }));
    setError(null);
  };

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      isEdit ? api.updateProvider(initial!.id, payload) : api.createProvider(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast(isEdit ? 'Provider updated' : 'Provider created');
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    try {
      save.mutate(formPayload(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Edit provider' : 'Add provider'}
      description="Providers hold credentials and a base URL for one upstream vendor."
      width="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="provider-form" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form id="provider-form" onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="Shown in the dashboard only">
          <Input value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="OpenAI" autoFocus />
        </Field>

        <Field label="Adapters" hint={form.adapters.map((a) => ADAPTER_HINTS[a]).join(' ')}>
          <div className="flex flex-wrap gap-2">
            {ALL_ADAPTERS.map((a) => {
              const checked = form.adapters.includes(a);
              return (
                <label
                  key={a}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
                    checked ? 'border-emerald-500/60 bg-emerald-500/10 text-zinc-100' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleAdapter(a)}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                  {ADAPTER_LABELS[a]}
                </label>
              );
            })}
          </div>
        </Field>

        <Field
          label="Base URL"
          hint={
            form.adapters.length > 1
              ? 'One URL serves the selected dialects — paste it with or without /v1; each dialect is routed correctly.'
              : form.adapters[0] === 'anthropic'
                ? 'Paste the origin (with or without /v1) — /v1/messages is appended automatically. Default: https://api.anthropic.com'
                : form.adapters[0] === 'gemini'
                  ? 'Paste the API root (bare origin gains /v1beta) — /models/{model}:generateContent is appended automatically. Default: https://generativelanguage.googleapis.com/v1beta'
                  : 'Paste the API root with or without /v1 — /chat/completions is appended automatically. Default: https://api.openai.com/v1'
          }
        >
          <Input
            value={form.base_url}
            onChange={(e) => setField('base_url', e.target.value)}
            placeholder={ADAPTER_DEFAULTS[form.adapters[0] ?? 'openai'] + ' (default)'}
          />
        </Field>

        <Field label="Quick fill" hint="Well-known vendors — fills the URL and checks the right adapters">
          <div className="flex flex-wrap gap-1.5">
            {relevantPresets.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => applyPreset(p)}
                title={`${p.baseUrl} · ${p.hint}`}
                className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:border-emerald-500/60 hover:text-zinc-100"
              >
                {p.name}
                {p.adapters.length === 2 ? <span className="ml-1 text-emerald-400" title="Serves both dialects">×</span> : null}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="API key"
          hint={isEdit && initial?.key_hint ? `Encrypted at rest · current key ends “${initial.key_hint}” — leave blank to keep` : 'Stored encrypted (AES-256-GCM)'}
        >
          <Input
            type="password"
            value={form.api_key}
            onChange={(e) => setField('api_key', e.target.value)}
            placeholder={isEdit && initial?.key_hint ? '••••••••••••' : 'sk-… (optional for local endpoints)'}
            autoComplete="new-password"
          />
        </Field>

        <Field label="Default headers" hint="JSON object, merged into every upstream request">
          <Textarea
            rows={3}
            value={form.default_headers}
            onChange={(e) => setField('default_headers', e.target.value)}
            placeholder={'{ "X-Title": "Khateway" }'}
            className="font-mono text-xs"
          />
        </Field>

        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <Field label="Timeout (ms)" hint="Applied to connection tests and gateway calls">
            <Input
              type="number"
              min={1000}
              max={120000}
              step={500}
              value={form.timeout_ms}
              onChange={(e) => setField('timeout_ms', e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-2 pb-2">
            <Switch checked={form.enabled} onChange={(v) => setField('enabled', v)} />
            <span className="text-[13px] text-zinc-400">Enabled</span>
          </div>
        </div>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </form>
    </Modal>
  );
}

export function Providers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['providers'], queryFn: api.providers });

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Provider | null | undefined>(undefined); // undefined = closed, null = create
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [pendingTest, setPendingTest] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (p: Provider) => api.updateProvider(p.id, { enabled: !p.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['models', ''] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast('Provider deleted');
      setDeleting(null);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  const runTest = async (id: string) => {
    setPendingTest(id);
    try {
      const r = await api.testProvider(id);
      setTests((m) => ({ ...m, [id]: r }));
      if (r.ok) {
        toast(`Connection OK — ${r.latency_ms ?? '?'} ms${r.model_count != null ? ` · ${r.model_count} models` : ''}`);
      } else {
        toast(`Test failed: ${r.error ?? `HTTP ${r.status}`}`, 'err');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test failed', 'err');
    } finally {
      setPendingTest(null);
    }
  };

  const providers = q.data ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return providers;
    return providers.filter((p) => p.name.toLowerCase().includes(s) || (p.base_url ?? '').toLowerCase().includes(s));
  }, [providers, search]);

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle="Upstream accounts Khateway can forward to. API keys are encrypted at rest."
        action={
          <Button onClick={() => setEditing(null)}>
            <Plus className="h-4 w-4" />
            Add provider
          </Button>
        }
      />

      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : providers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server className="h-8 w-8" />}
            title="No providers yet"
            description="Add OpenAI, Anthropic, or any OpenAI-compatible endpoint (Groq, DeepSeek, Gemini-compat, Ollama…)."
            action={
              <Button onClick={() => setEditing(null)}>
                <Plus className="h-4 w-4" />
                Add your first provider
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="border-b border-zinc-800 px-4 py-2.5">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or base URL…"
              className="h-8 w-72 text-xs"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Provider</th>
                  <th className="px-4 py-2.5 font-medium">API key</th>
                  <th className="px-4 py-2.5 font-medium">Models</th>
                  <th className="px-4 py-2.5 font-medium">Enabled</th>
                  <th className="px-4 py-2.5 font-medium">Test</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filtered.map((p) => (
                  <tr key={p.id} className="group transition-colors hover:bg-zinc-900/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">{p.name}</span>
                        {(p.adapters?.length ? p.adapters : [p.adapter]).map((a) => (
                          <Badge key={a} title={ADAPTER_LABELS[a]}>{ADAPTER_LABELS[a]}</Badge>
                        ))}
                        {!p.enabled ? <Badge tone="warn">disabled</Badge> : null}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                        {p.base_url ?? `${ADAPTER_DEFAULTS[p.adapter]} (default)`}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {p.key_hint ? `•••• ${p.key_hint}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{p.model_count}</td>
                    <td className="px-4 py-3">
                      <Switch checked={p.enabled} onChange={() => toggle.mutate(p)} />
                    </td>
                    <td className="px-4 py-3">
                      {pendingTest === p.id ? (
                        <Spinner />
                      ) : tests[p.id] ? (
                        tests[p.id].ok ? (
                          <Badge tone="ok" title={`HTTP ${tests[p.id].status}${tests[p.id].model_count != null ? ` · ${tests[p.id].model_count} models` : ''}`}>
                            {tests[p.id].latency_ms ?? '?'} ms
                          </Badge>
                        ) : (
                          <Badge tone="bad" title={tests[p.id].error ?? `HTTP ${tests[p.id].status}`}>
                            Failed
                          </Badge>
                        )
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => runTest(p.id)} title="Send a test request to this provider">
                          <PlugZap className="h-3.5 w-3.5" />
                          Test
                        </Button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button variant="ghost" size="icon" title="Edit provider" onClick={() => setEditing(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Delete provider" onClick={() => setDeleting(p)}>
                          <Trash2 className="h-3.5 w-3.5 text-red-300" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {filtered.length === 0 && providers.length > 0 ? (
        <p className="mt-3 text-center text-xs text-zinc-500">No providers match “{search}”.</p>
      ) : null}

      {editing !== undefined ? (
        <ProviderModal initial={editing} onClose={() => setEditing(undefined)} />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        title="Delete provider"
        body={`Delete “${deleting?.name}”? Its ${deleting?.model_count ?? 0} model(s) will be removed too. Clients routing those slugs will see errors.`}
        busy={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
