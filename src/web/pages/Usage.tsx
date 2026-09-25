// Admin usage dashboard: time-series charts + breakdowns over request_logs,
// backed by GET /api/admin/usage. Charts are the hand-rolled SVG primitives
// in components/charts.tsx — no chart library, per the repo's stack rules.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw } from 'lucide-react';
import { api, type Usage, type UsageTotals } from '../api';
import { Button, Card, EmptyState, PageHeader, Select, Spinner, fmtPrice, fmtTokens } from '../components/ui';
import { Delta, HBars, StackedBarChart } from '../components/charts';
import { Link } from '../router';

const RANGES = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

const COLORS = {
  requests: '#34d399',
  errors: '#f87171',
  tokensIn: '#34d399',
  tokensOut: '#38bdf8',
};

const DIALECT_LABELS: Record<string, string> = {
  chat: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  embeddings: '/embeddings',
  completions: '/completions',
};

function bucketDate(bucket: string): Date {
  return new Date(bucket + 'Z'); // buckets are UTC wall-clock strings
}

/** Short x-axis tick: hour buckets show the time (date at midnight), day buckets the date. */
function tickLabel(bucket: string, kind: Usage['bucket']): string {
  const d = bucketDate(bucket);
  if (kind === 'day' || d.getUTCHours() === 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fullLabel(bucket: string, kind: Usage['bucket']): string {
  const d = bucketDate(bucket);
  return kind === 'hour'
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return '—';
  if (ms >= 1000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms)} ms`;
}

function fmtCost(n: number): string {
  if (n === 0) return '$0';
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

const errorRate = (t: UsageTotals) => (t.requests > 0 ? ((t.errors_4xx + t.errors_5xx) / t.requests) * 100 : 0);

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function ChartCard({ title, legend, children }: { title: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-300">{title}</h2>
        {legend ? <div className="flex items-center gap-3 text-[11px] text-zinc-500">{legend}</div> : null}
      </div>
      {children}
    </Card>
  );
}

function MiniBar({ frac }: { frac: number }) {
  return (
    <div className="h-1.5 w-full max-w-28 rounded-full bg-zinc-800">
      <div className="h-1.5 rounded-full bg-emerald-500/80" style={{ width: `${Math.min(Math.max(frac * 100, 0), 100)}%` }} />
    </div>
  );
}

function UsageStat({ label, value, delta }: { label: string; value: string; delta?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-[12px] text-zinc-400">{label}</div>
      <div className="mt-2 flex items-baseline">
        <span className="text-2xl font-semibold tracking-tight text-zinc-100">{value}</span>
        {delta}
      </div>
    </Card>
  );
}

export function Usage() {
  const [days, setDays] = useState(7);
  const [keyF, setKeyF] = useState('');
  const [modelF, setModelF] = useState('');
  const [providerF, setProviderF] = useState('');
  const [dialectF, setDialectF] = useState('');

  const kq = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const pq = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const mq = useQuery({ queryKey: ['models', ''], queryFn: () => api.models(undefined) });

  const anyFilter = !!(keyF || modelF || providerF || dialectF);
  const resetFilters = () => {
    setKeyF('');
    setModelF('');
    setProviderF('');
    setDialectF('');
  };

  const q = useQuery({
    queryKey: ['usage', days, keyF, modelF, providerF, dialectF],
    queryFn: () =>
      api.usage({
        days,
        api_key_id: keyF || undefined,
        model: modelF || undefined,
        provider: providerF || undefined,
        dialect: dialectF || undefined,
      }),
    placeholderData: (prev) => prev, // keep the previous view up while a filter switch refetches
    refetchInterval: 60_000, // dashboard is a live surface — poll gently
  });

  const data = q.data;

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="Requests, tokens, spend and errors across every client key — bucketed in UTC, shown in your local time."
        action={
          <div className="flex gap-2">
            <div className="w-40">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 text-sm">
                {RANGES.map((r) => (
                  <option key={r.days} value={r.days}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={'h-4 w-4' + (q.isFetching ? ' animate-spin' : '')} />
              Refresh
            </Button>
          </div>
        }
      />

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <span className="mr-1 text-[11px] font-medium tracking-wide text-zinc-600 uppercase">Filter</span>
          <div className="w-40">
            <Select value={keyF} onChange={(e) => setKeyF(e.target.value)} className="h-8 text-xs">
              <option value="">All keys</option>
              {(kq.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-44">
            <Select value={modelF} onChange={(e) => setModelF(e.target.value)} className="h-8 text-xs">
              <option value="">All models</option>
              {(mq.data ?? []).map((m) => (
                <option key={m.id} value={m.slug}>
                  {m.slug}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select value={providerF} onChange={(e) => setProviderF(e.target.value)} className="h-8 text-xs">
              <option value="">All providers</option>
              {(pq.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select value={dialectF} onChange={(e) => setDialectF(e.target.value)} className="h-8 text-xs">
              <option value="">All endpoints</option>
              {Object.entries(DIALECT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {anyFilter ? (
            <button onClick={resetFilters} className="text-xs text-zinc-500 hover:text-zinc-300">
              Reset
            </button>
          ) : null}
        </div>
      </Card>

      {q.isLoading || !data ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : data.totals.requests === 0 ? (
        <Card>
          <EmptyState
            icon={<BarChart3 className="h-8 w-8" />}
            title={anyFilter ? 'No requests match the current filters' : 'No requests in this window'}
            description={
              anyFilter
                ? 'Nothing matches the current range and filters — widen the range or reset them.'
                : 'Once clients hit the gateway, usage shows up here — try the Playground to make the first call.'
            }
            action={
              anyFilter ? (
                <Button variant="outline" onClick={resetFilters}>
                  Reset filters
                </Button>
              ) : (
                <Link to="/admin/playground">
                  <Button variant="outline">Open the Playground</Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <UsageStat label="Requests" value={data.totals.requests.toLocaleString()} delta={<Delta current={data.totals.requests} previous={data.prev_totals.requests} />} />
            <UsageStat label="Spend" value={fmtPrice(data.totals.cost_usd)} delta={<Delta current={data.totals.cost_usd} previous={data.prev_totals.cost_usd} inverse />} />
            <UsageStat label="Tokens in" value={fmtTokens(data.totals.tokens_in)} delta={<Delta current={data.totals.tokens_in} previous={data.prev_totals.tokens_in} />} />
            <UsageStat label="Tokens out" value={fmtTokens(data.totals.tokens_out)} delta={<Delta current={data.totals.tokens_out} previous={data.prev_totals.tokens_out} />} />
            <UsageStat
              label="Error rate"
              value={`${errorRate(data.totals).toFixed(1)}%`}
              delta={<Delta current={errorRate(data.totals)} previous={errorRate(data.prev_totals)} inverse />}
            />
            <UsageStat
              label="Avg latency"
              value={fmtLatency(data.totals.avg_latency_ms)}
              delta={<Delta current={data.totals.avg_latency_ms} previous={data.prev_totals.avg_latency_ms} inverse />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Requests & errors"
              legend={
                <>
                  <LegendDot color={COLORS.requests} label="Requests" />
                  <LegendDot color={COLORS.errors} label="Errors" />
                </>
              }
            >
              <StackedBarChart
                labels={data.series.map((p) => tickLabel(p.bucket, data.bucket))}
                tooltipLabels={data.series.map((p) => fullLabel(p.bucket, data.bucket))}
                series={[
                  { name: 'Requests', color: COLORS.requests, values: data.series.map((p) => p.requests - p.errors) },
                  { name: 'Errors', color: COLORS.errors, values: data.series.map((p) => p.errors) },
                ]}
              />
            </ChartCard>

            <ChartCard title="Spend (USD)">
              <StackedBarChart
                labels={data.series.map((p) => tickLabel(p.bucket, data.bucket))}
                tooltipLabels={data.series.map((p) => fullLabel(p.bucket, data.bucket))}
                formatValue={fmtCost}
                series={[{ name: 'Spend', color: COLORS.requests, values: data.series.map((p) => p.cost_usd) }]}
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Tokens"
            legend={
              <>
                <LegendDot color={COLORS.tokensIn} label="In" />
                <LegendDot color={COLORS.tokensOut} label="Out" />
              </>
            }
          >
            <StackedBarChart
              labels={data.series.map((p) => tickLabel(p.bucket, data.bucket))}
              tooltipLabels={data.series.map((p) => fullLabel(p.bucket, data.bucket))}
              series={[
                { name: 'Tokens in', color: COLORS.tokensIn, values: data.series.map((p) => p.tokens_in) },
                { name: 'Tokens out', color: COLORS.tokensOut, values: data.series.map((p) => p.tokens_out) },
              ]}
            />
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h2 className="mb-4 text-sm font-medium text-zinc-300">Top models</h2>
              {data.by_model.length > 0 ? (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] text-zinc-500">
                      <th className="pb-2 font-medium">Model</th>
                      <th className="pb-2 font-medium">Requests</th>
                      <th className="pb-2 font-medium">Tokens in / out</th>
                      <th className="pb-2 font-medium">Spend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {data.by_model.map((m) => {
                      const maxReq = Math.max(...data.by_model.map((x) => x.requests), 1);
                      return (
                        <tr key={m.model_slug}>
                          <td className="py-2.5 pr-3 font-mono text-xs text-zinc-200">
                            <span className="block max-w-56 truncate" title={m.model_slug}>
                              {m.model_slug}
                            </span>
                            <MiniBar frac={m.requests / maxReq} />
                          </td>
                          <td className="py-2.5 font-mono text-xs text-zinc-400">{m.requests.toLocaleString()}</td>
                          <td className="py-2.5 font-mono text-xs text-zinc-400">
                            {fmtTokens(m.tokens_in)} / {fmtTokens(m.tokens_out)}
                          </td>
                          <td className="py-2.5 font-mono text-xs text-zinc-400">{fmtPrice(m.cost_usd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="py-6 text-center text-[13px] text-zinc-500">No model traffic in this window.</p>
              )}
            </Card>

            <div className="space-y-4">
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-medium text-zinc-300">By endpoint</h2>
                <HBars
                  items={data.by_dialect.map((d) => ({
                    label: DIALECT_LABELS[d.dialect] ?? d.dialect,
                    value: d.requests,
                    display: d.requests.toLocaleString(),
                    sub: `${fmtPrice(d.cost_usd)} spend`,
                  }))}
                  emptyText="No requests in this window."
                />
              </Card>

              <Card className="p-5">
                <h2 className="mb-4 text-sm font-medium text-zinc-300">Top keys by spend</h2>
                <HBars
                  items={data.by_key.map((k) => ({
                    label: k.key_name ?? '(deleted key)',
                    value: k.cost_usd,
                    display: fmtPrice(k.cost_usd),
                    sub: `${k.requests.toLocaleString()} requests`,
                  }))}
                  emptyText="No key traffic in this window."
                />
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
