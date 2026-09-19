import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { api, type LogRow } from '../api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, PageHeader, Select, Spinner, fmtPrice, fmtTokens, toast } from '../components/ui';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  );
}

function statusTone(status: number): 'ok' | 'warn' | 'bad' {
  if (status < 400) return 'ok';
  if (status < 500) return 'warn';
  return 'bad';
}

const DIALECT_LABELS: Record<LogRow['dialect'], string> = {
  chat: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  embeddings: '/embeddings',
};

function LogErrorCell({ log }: { log: LogRow }) {
  if (!log.error) return <span className="text-xs text-zinc-600">—</span>;
  return (
    <span className="cursor-help text-xs text-red-300/90" title={log.error}>
      {log.error.length > 60 ? `${log.error.slice(0, 60)}…` : log.error}
    </span>
  );
}

export function Logs() {
  const qc = useQueryClient();
  const [keyFilter, setKeyFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dialectFilter, setDialectFilter] = useState('');
  const [clearing, setClearing] = useState(false);

  const lq = useQuery({
    queryKey: ['logs', keyFilter, modelFilter, statusFilter, dialectFilter],
    queryFn: () =>
      api.logs({
        api_key_id: keyFilter || undefined,
        model: modelFilter.trim() || undefined,
        status: statusFilter || undefined,
        dialect: dialectFilter || undefined,
        limit: 200,
      }),
    refetchInterval: 15_000, // logs are a live surface — poll gently
  });

  const kq = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });

  const clear = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['logs'] });
      qc.invalidateQueries({ queryKey: ['api-keys'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      toast('Request logs cleared');
      setClearing(false);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Clear failed', 'err'),
  });

  const logs = lq.data ?? [];
  const anyFilter = !!(keyFilter || modelFilter.trim() || statusFilter || dialectFilter);

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle="Every gateway request with latency, token usage and cost — usage for streams is captured after the stream ends."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => lq.refetch()} disabled={lq.isFetching}>
              <RefreshCw className={'h-4 w-4' + (lq.isFetching ? ' animate-spin' : '')} />
              Refresh
            </Button>
            <Button variant="danger" onClick={() => setClearing(true)} disabled={logs.length === 0}>
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <div className="w-44">
            <Select value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} className="h-8 text-xs">
              <option value="">All keys</option>
              {(kq.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select value={dialectFilter} onChange={(e) => setDialectFilter(e.target.value)} className="h-8 text-xs">
              <option value="">All endpoints</option>
              <option value="chat">/chat/completions</option>
              <option value="responses">/responses</option>
              <option value="messages">/messages</option>
              <option value="embeddings">/embeddings</option>
            </Select>
          </div>
          <div className="w-28">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-8 text-xs">
              <option value="">All status</option>
              <option value="2xx">2xx</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
            </Select>
          </div>
          <Input
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            placeholder="Model slug…"
            className="h-8 w-44 text-xs"
          />
          {anyFilter ? (
            <button
              onClick={() => {
                setKeyFilter('');
                setModelFilter('');
                setStatusFilter('');
                setDialectFilter('');
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Reset
            </button>
          ) : null}
        </div>

        {lq.isLoading ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="h-8 w-8" />}
            title={anyFilter ? 'No matching requests' : 'No requests yet'}
            description={
              anyFilter
                ? 'Nothing matches the current filters.'
                : 'Point a client at /v1 with an API key — requests show up here in real time.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Key</th>
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 font-medium">Endpoint</th>
                  <th className="px-4 py-2.5 font-medium">Provider → upstream</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Latency</th>
                  <th className="px-4 py-2.5 font-medium">Tokens in/out</th>
                  <th className="px-4 py-2.5 font-medium">Cost</th>
                  <th className="px-4 py-2.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {logs.map((log) => (
                  <tr key={log.id} className="transition-colors hover:bg-zinc-900/40">
                    <td className="px-4 py-2.5 font-mono text-[11px] whitespace-nowrap text-zinc-500">{fmtTime(log.created_at)}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-300">{log.key_name ?? <span className="text-zinc-600">(deleted)</span>}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-200">
                      {log.model_slug}
                      {log.cache_hit ? (
                        <Badge tone="ok" className="ml-1.5" title="Served from the semantic cache — no upstream call">
                          cached
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-500">{DIALECT_LABELS[log.dialect] ?? log.dialect}</td>
                    <td className="px-4 py-2.5 text-xs text-zinc-400">
                      {log.provider_name ? (
                        <>
                          {log.provider_name} <span className="text-zinc-600">→ {log.upstream_model}</span>
                        </>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={statusTone(log.status)}>{log.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{log.latency_ms != null ? `${log.latency_ms} ms` : '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                      {fmtTokens(log.tokens_in)} / {fmtTokens(log.tokens_out)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{fmtPrice(log.cost_usd)}</td>
                    <td className="max-w-64 px-4 py-2.5">
                      <LogErrorCell log={log} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={clearing}
        title="Clear request logs"
        body="Delete every request log row? Spend accruals and per-key usage counters restart from zero."
        confirmLabel="Clear logs"
        busy={clear.isPending}
        onConfirm={() => clear.mutate()}
        onClose={() => setClearing(false)}
      />
    </div>
  );
}
