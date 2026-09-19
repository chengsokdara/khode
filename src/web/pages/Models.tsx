import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Pencil, Plus, Trash2 } from 'lucide-react';
import { ADAPTER_LABELS, api, CAPABILITIES, type ModelRow, type Provider } from '../api';
import { navigate } from '../router';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  fmtPrice,
  fmtTokens,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Switch,
  toast,
} from '../components/ui';

type FormState = {
  provider_id: string;
  slug: string;
  display_name: string;
  upstream_model: string;
  context_window: string;
  max_output_tokens: string;
  pricing_input: string;
  pricing_output: string;
  rate_limit_rpm: string;
  cache_enabled: boolean;
  capabilities: string[];
  base_url_override: string;
  api_key_override: string;
  enabled: boolean;
};

/** '' | null | number — '' is treated as null (inherit / unset). */
function numOrNull(s: string, allowFloat: boolean): number | null | 'invalid' {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (!allowFloat && !Number.isInteger(n)) return 'invalid';
  return n;
}

function ModelModal({
  initial,
  providers,
  onClose,
}: {
  initial: ModelRow | null;
  providers: Provider[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!initial;
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(!!(initial?.base_url_override || initial?.key_hint));
  const [form, setForm] = useState<FormState>(() =>
    initial
      ? {
          provider_id: initial.provider_id,
          slug: initial.slug,
          display_name: initial.display_name ?? '',
          upstream_model: initial.upstream_model ?? '',
          context_window: initial.context_window != null ? String(initial.context_window) : '',
          max_output_tokens: initial.max_output_tokens != null ? String(initial.max_output_tokens) : '',
          pricing_input: initial.pricing_input != null ? String(initial.pricing_input) : '',
          pricing_output: initial.pricing_output != null ? String(initial.pricing_output) : '',
          rate_limit_rpm: initial.rate_limit_rpm != null ? String(initial.rate_limit_rpm) : '',
          cache_enabled: initial.cache_enabled,
          capabilities: initial.capabilities,
          base_url_override: initial.base_url_override ?? '',
          api_key_override: '',
          enabled: initial.enabled,
        }
      : {
          provider_id: providers[0]?.id ?? '',
          slug: '',
          display_name: '',
          upstream_model: '',
          context_window: '',
          max_output_tokens: '',
          pricing_input: '',
          pricing_output: '',
          rate_limit_rpm: '',
          cache_enabled: false,
          capabilities: [],
          base_url_override: '',
          api_key_override: '',
          enabled: true,
        },
  );

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      isEdit ? api.updateModel(initial!.id, payload) : api.createModel(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast(isEdit ? 'Model updated' : 'Model registered');
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const slug = form.slug.trim();
    if (!slug) {
      setError('Slug is required — clients put this in the "model" field');
      return;
    }
    if (!form.provider_id) {
      setError('Choose a provider');
      return;
    }
    const ctx = numOrNull(form.context_window, false);
    if (ctx === 'invalid') {
      setError('Context window must be an integer ≥ 0');
      return;
    }
    const out = numOrNull(form.max_output_tokens, false);
    if (out === 'invalid') {
      setError('Max output must be an integer ≥ 0');
      return;
    }
    const pin = numOrNull(form.pricing_input, true);
    if (pin === 'invalid') return setError('Pricing input must be a number ≥ 0');
    const pout = numOrNull(form.pricing_output, true);
    if (pout === 'invalid') return setError('Pricing output must be a number ≥ 0');
    const rpm = form.rate_limit_rpm.trim() === '' ? null : numOrNull(form.rate_limit_rpm, false);
    if (rpm === 'invalid' || (typeof rpm === 'number' && rpm < 1)) {
      return setError('Rate limit must be an integer ≥ 1 request/minute (blank = unlimited)');
    }

    const payload: Record<string, unknown> = {
      provider_id: form.provider_id,
      slug,
      display_name: form.display_name.trim() || null,
      upstream_model: form.upstream_model.trim() || null,
      context_window: ctx,
      max_output_tokens: out,
      pricing_input: pin,
      pricing_output: pout,
      rate_limit_rpm: rpm,
      cache_enabled: form.cache_enabled,
      capabilities: form.capabilities,
      base_url_override: form.base_url_override.trim() || null,
      enabled: form.enabled,
    };
    if (form.api_key_override.trim()) payload.api_key_override = form.api_key_override.trim();
    save.mutate(payload);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit model — ${initial!.slug}` : 'Register model'}
      description="The slug is what clients send in the model field; routing maps it to this provider."
      width="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="model-form" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Register model'}
          </Button>
        </>
      }
    >
      <form id="model-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={form.provider_id} onChange={(e) => setField('provider_id', e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Slug" hint="Globally unique, e.g. gpt-5, claude-sonnet-4-5">
            <Input value={form.slug} onChange={(e) => setField('slug', e.target.value)} placeholder="gpt-5" autoFocus={!isEdit} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" hint="Optional, dashboard only">
            <Input value={form.display_name} onChange={(e) => setField('display_name', e.target.value)} placeholder="GPT-5" />
          </Field>
          <Field label="Upstream model ID" hint="Sent to the provider; blank = same as slug">
            <Input
              value={form.upstream_model}
              onChange={(e) => setField('upstream_model', e.target.value)}
              placeholder="gpt-5 (defaults to slug)"
              className="font-mono text-xs"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Context window">
            <Input type="number" min={0} value={form.context_window} onChange={(e) => setField('context_window', e.target.value)} placeholder="200000" />
          </Field>
          <Field label="Max output tokens">
            <Input type="number" min={0} value={form.max_output_tokens} onChange={(e) => setField('max_output_tokens', e.target.value)} placeholder="8192" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pricing input" hint="USD per 1M tokens, e.g. 3.00">
            <Input type="number" min={0} step={0.0001} value={form.pricing_input} onChange={(e) => setField('pricing_input', e.target.value)} />
          </Field>
          <Field label="Pricing output" hint="USD per 1M tokens, e.g. 15.00">
            <Input type="number" min={0} step={0.0001} value={form.pricing_output} onChange={(e) => setField('pricing_output', e.target.value)} />
          </Field>
        </div>

        <Field label="Rate limit" hint="Global requests/minute for this model, shared by all clients — blank = unlimited">
          <Input type="number" min={1} value={form.rate_limit_rpm} onChange={(e) => setField('rate_limit_rpm', e.target.value)} placeholder="unlimited" />
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 text-xs text-zinc-300">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-emerald-500"
            checked={form.cache_enabled}
            onChange={(e) => setField('cache_enabled', e.target.checked)}
          />
          <span>
            Semantic cache
            <span className="block text-[11px] leading-relaxed text-zinc-500">
              Repeat text-only, non-streaming requests are served from cache until the entry expires (Settings
              sets the lifetime). Still logged and billed.
            </span>
          </span>
        </label>

        <Field label="Capabilities">
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            {CAPABILITIES.map((c) => {
              const checked = form.capabilities.includes(c);
              return (
                <label key={c} className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-emerald-500"
                    checked={checked}
                    onChange={() => {
                      setForm((f) => ({
                        ...f,
                        capabilities: checked ? f.capabilities.filter((x) => x !== c) : [...f.capabilities, c],
                      }));
                    }}
                  />
                  {c}
                </label>
              );
            })}
          </div>
        </Field>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-xs font-medium text-zinc-400 hover:text-zinc-200"
          >
            Advanced {advancedOpen ? '▾' : '▸'}
          </button>
          {advancedOpen ? (
            <div className="mt-3 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
              <Field label="Base URL override" hint="Leave blank to inherit the provider's base URL">
                <Input
                  value={form.base_url_override}
                  onChange={(e) => setField('base_url_override', e.target.value)}
                  placeholder="https://… (inherit)"
                  className="font-mono text-xs"
                />
              </Field>
              <Field
                label="API key override"
                hint={isEdit && initial?.key_hint ? `Current override ends “${initial.key_hint}” — blank keeps it` : 'Overrides the provider key for this model'}
              >
                <Input
                  type="password"
                  value={form.api_key_override}
                  onChange={(e) => setField('api_key_override', e.target.value)}
                  placeholder={isEdit && initial?.key_hint ? '••••••••••••' : 'sk-… (inherit by default)'}
                  autoComplete="new-password"
                />
              </Field>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={form.enabled} onChange={(v) => setField('enabled', v)} />
          <span className="text-[13px] text-zinc-400">Enabled</span>
        </div>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </form>
    </Modal>
  );
}

export function Models() {
  const qc = useQueryClient();
  const pq = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const [providerFilter, setProviderFilter] = useState('');
  const mq = useQuery({
    queryKey: ['models', providerFilter],
    queryFn: () => api.models(providerFilter || undefined),
  });

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ModelRow | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<ModelRow | null>(null);

  const providers = pq.data ?? [];
  const models = mq.data ?? [];

  const toggle = useMutation({
    mutationFn: (m: ModelRow) => api.updateModel(m.id, { enabled: !m.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Update failed', 'err'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast('Model deleted');
      setDeleting(null);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Delete failed', 'err'),
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return models;
    return models.filter((m) =>
      [m.slug, m.display_name ?? '', m.upstream_model ?? '', m.provider_name].some((v) => v.toLowerCase().includes(s)),
    );
  }, [models, search]);

  const noProviders = providers.length === 0;

  return (
    <div>
      <PageHeader
        title="Models"
        subtitle="Platform slugs clients route through — each maps to a provider's upstream model."
        action={
          <Button
            onClick={() => setEditing(null)}
            disabled={noProviders}
            title={noProviders ? 'Add a provider first' : undefined}
          >
            <Plus className="h-4 w-4" />
            Add model
          </Button>
        }
      />

      {pq.isLoading || mq.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : noProviders ? (
        <Card>
          <EmptyState
            icon={<Boxes className="h-8 w-8" />}
            title="No providers yet"
            description="Models are registered against a provider. Add OpenAI, Anthropic, or any OpenAI-compatible endpoint first."
            action={<Button onClick={() => navigate('/providers')}>Go to providers</Button>}
          />
        </Card>
      ) : models.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Boxes className="h-8 w-8" />}
            title="No models yet"
            description="Register the slugs your clients will use and map them to a provider's upstream model ID."
            action={
              <Button onClick={() => setEditing(null)}>
                <Plus className="h-4 w-4" />
                Register your first model
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
            <div className="w-52">
              <Select
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className="h-8 text-xs"
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter models…"
              className="h-8 w-64 text-xs"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 font-medium">Provider</th>
                  <th className="px-4 py-2.5 font-medium">Upstream ID</th>
                  <th className="px-4 py-2.5 font-medium">Ctx / out</th>
                  <th className="px-4 py-2.5 font-medium">$/1M in · out</th>
                  <th className="px-4 py-2.5 font-medium">Capabilities</th>
                  <th className="px-4 py-2.5 font-medium">Enabled</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {filtered.map((m) => (
                  <tr key={m.id} className="group transition-colors hover:bg-zinc-900/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">{m.slug}</span>
                        {!m.enabled ? <Badge tone="warn">disabled</Badge> : null}
                      </div>
                      {m.display_name ? (
                        <div className="mt-0.5 text-[11px] text-zinc-500">{m.display_name}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-zinc-300">{m.provider_name}</span>{' '}
                      {(m.provider_adapters?.length ? m.provider_adapters : [m.provider_adapter]).map((a) => (
                        <Badge key={a} title={ADAPTER_LABELS[a]}>{a}</Badge>
                      ))}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {m.upstream_model ?? '(= slug)'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {fmtTokens(m.context_window)} / {fmtTokens(m.max_output_tokens)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {fmtPrice(m.pricing_input)} · {fmtPrice(m.pricing_output)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {m.capabilities.slice(0, 3).map((c) => (
                          <Badge key={c}>{c}</Badge>
                        ))}
                        {m.capabilities.length > 3 ? <Badge>+{m.capabilities.length - 3}</Badge> : null}
                        {m.capabilities.length === 0 ? <span className="text-xs text-zinc-600">—</span> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Switch checked={m.enabled} onChange={() => toggle.mutate(m)} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button variant="ghost" size="icon" title="Edit model" onClick={() => setEditing(m)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Delete model" onClick={() => setDeleting(m)}>
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

      {filtered.length === 0 && models.length > 0 ? (
        <p className="mt-3 text-center text-xs text-zinc-500">No models match “{search}”.</p>
      ) : null}

      {editing !== undefined ? (
        <ModelModal initial={editing} providers={providers} onClose={() => setEditing(undefined)} />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        title="Delete model"
        body={`Delete “${deleting?.slug}”? Clients routing this slug will start receiving 404s.`}
        busy={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
