import { useQuery } from '@tanstack/react-query';
import { Boxes, Check, CircleDot, KeyRound, PlugZap, Server } from 'lucide-react';
import { api } from '../api';
import { Badge, Card, PageHeader, Spinner, fmtPrice, fmtTokens } from '../components/ui';
import { Link } from '../router';

function StatCard(props: { icon: React.ReactNode; label: string; value: number | undefined; sub: string; to: string }) {
  return (
    <Link to={props.to} className="block">
      <Card className="p-5 transition-colors hover:border-zinc-700">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-zinc-400">{props.label}</span>
          <span className="text-zinc-600">{props.icon}</span>
        </div>
        <div className="mt-3 text-3xl font-semibold tracking-tight text-zinc-100">
          {props.value === undefined ? <span className="text-zinc-600">·</span> : props.value}
        </div>
        <div className="mt-1 text-xs text-zinc-500">{props.sub}</div>
      </Card>
    </Link>
  );
}

export function Overview() {
  const q = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const mq = useQuery({ queryKey: ['models', ''], queryFn: () => api.models(undefined) });

  const providers = q.data?.providers ?? 0;
  const modelsCount = q.data?.models ?? 0;
  const keys = q.data?.api_keys ?? 0;

  const steps = [
    { label: 'Add a provider', done: providers > 0, to: '/providers' },
    { label: 'Register models', done: modelsCount > 0, to: '/models' },
    { label: 'Create an API key', done: keys > 0, to: '/api-keys' },
    { label: 'Point clients at /v1', done: (q.data?.usage_24h.requests ?? 0) > 0, to: '/api-keys' },
  ];

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="One base URL, every provider — route, translate and observe."
      />

      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              to="/providers"
              icon={<Server className="h-4 w-4" />}
              label="Providers"
              value={q.data?.providers}
              sub={`${q.data?.providers_enabled ?? 0} enabled`}
            />
            <StatCard
              to="/models"
              icon={<Boxes className="h-4 w-4" />}
              label="Models"
              value={q.data?.models}
              sub={`${q.data?.models_enabled ?? 0} enabled`}
            />
            <StatCard
              to="/api-keys"
              icon={<KeyRound className="h-4 w-4" />}
              label="API keys"
              value={q.data?.api_keys}
              sub={`${q.data?.usage_24h.requests ?? 0} requests / 24h`}
            />
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-zinc-400">Usage · 24h</span>
                <Badge tone="ok">live</Badge>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tracking-tight text-zinc-100">{fmtTokens(q.data?.usage_24h.tokens_in ?? 0)}</span>
                <span className="text-xs text-zinc-500">in /</span>
                <span className="text-2xl font-semibold tracking-tight text-zinc-100">{fmtTokens(q.data?.usage_24h.tokens_out ?? 0)}</span>
                <span className="text-xs text-zinc-500">out</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {fmtPrice(q.data?.usage_24h.cost_usd ?? 0)} accrued
                {q.data && q.data.usage_24h.cached > 0 ? (
                  <span className="text-emerald-500/80">
                    {' '}
                    · {q.data.usage_24h.cached} cached
                  </span>
                ) : null}
              </div>
            </Card>
          </div>

          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-zinc-300">Gateway endpoints</div>
                <div className="mt-2 space-y-1 font-mono text-[12px] text-zinc-500">
                  <div>POST /v1/chat/completions</div>
                  <div>POST /v1/responses</div>
                  <div>POST /v1/messages</div>
                  <div>GET&nbsp;&nbsp;/v1/models</div>
                </div>
              </div>
              <p className="max-w-md text-[11px] leading-relaxed text-zinc-600">
                All endpoints require a client API key (<code className="text-zinc-500">Authorization: Bearer khat-…</code> or{' '}
                <code className="text-zinc-500">x-api-key</code>). Any OpenAI or Anthropic SDK points here — Khateway
                translates between dialects and routes to the serving provider.
              </p>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-300">Recent models</h2>
                {mq.data?.length ? (
                  <Link to="/models" className="text-xs text-emerald-400 hover:underline">
                    View all →
                  </Link>
                ) : null}
              </div>
              {mq.data && mq.data.length > 0 ? (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] text-zinc-500">
                      <th className="pb-2 font-medium">Slug</th>
                      <th className="pb-2 font-medium">Provider</th>
                      <th className="pb-2 font-medium">Ctx / out</th>
                      <th className="pb-2 font-medium">$/1M in · out</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {mq.data.slice(0, 5).map((m) => (
                      <tr key={m.id} className="text-zinc-300">
                        <td className="py-2.5">
                          <span className="font-medium text-zinc-100">{m.slug}</span>
                          <span className="ml-2">
                            {!m.enabled ? <Badge tone="warn">disabled</Badge> : null}
                          </span>
                        </td>
                        <td className="py-2.5 text-zinc-400">{m.provider_name}</td>
                        <td className="py-2.5 font-mono text-xs text-zinc-500">
                          {fmtTokens(m.context_window)} / {fmtTokens(m.max_output_tokens)}
                        </td>
                        <td className="py-2.5 font-mono text-xs text-zinc-500">
                          {fmtPrice(m.pricing_input)} · {fmtPrice(m.pricing_output)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-6 text-center text-[13px] text-zinc-500">
                  No models yet — <Link to="/providers" className="text-emerald-400 hover:underline">add a provider</Link> first.
                </p>
              )}
            </Card>

            <Card className="p-5">
              <h2 className="mb-4 text-sm font-medium text-zinc-300">Getting started</h2>
              <ul className="space-y-3">
                {steps.map((s) => (
                  <li key={s.label} className="flex items-center gap-2.5 text-[13px]">
                    {s.done ? (
                      <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <CircleDot className="h-4 w-4 text-zinc-600" />
                    )}
                    {s.done ? (
                      <span className="text-zinc-500 line-through">{s.label}</span>
                    ) : (
                      <Link to={s.to} className="text-zinc-300 hover:text-emerald-300">
                        {s.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[11px] leading-relaxed text-zinc-500">
                <PlugZap className="mb-1.5 h-3.5 w-3.5 text-emerald-500/70" />
                Point any OpenAI or Anthropic SDK at this deployment with a client API key and use your
                platform slug in <code className="text-zinc-400">model</code>. Snippets live on the API Keys page.
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
