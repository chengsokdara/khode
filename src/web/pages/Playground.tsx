// Playground (M14) — in-admin chat tester against the REAL /v1 gateway.
// Requests ride a session-scoped client key (minted by /admin/playground/key)
// so they exercise the same auth/rate-limit/fallback/logging path as any
// external client, and each completion's request_logs row is shown below the
// transcript. Streaming uses the OpenAI chat dialect (SSE) — the one client
// face every upstream serves through translation.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '../router';
import { Send, Square } from 'lucide-react';
import { api, type LogRow, type ModelRow, type PlaygroundKey } from '../api';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, Textarea, cn, fmtPrice, fmtTokens } from '../components/ui';

type Turn = { role: 'user' | 'assistant'; content: string; streaming?: boolean; error?: boolean };

/** Reads an openai chat SSE body, invoking onDelta per text piece. */
async function streamChat(
  body: Record<string, unknown>,
  key: string,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } | string };
      msg = typeof data?.error === 'string' ? data.error : data?.error?.message || msg;
    } catch {
      // non-JSON error body — keep the HTTP status message
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
        } catch {
          // keepalive / unparsable frame — ignore
        }
      }
    }
  }
}

/** Polls the logs endpoint until the row for a just-finished request appears
 * (log writes land in waitUntil after the stream ends) or ~5 s elapse. */
async function waitForLogRow(keyId: string, since: number): Promise<LogRow[]> {
  for (let i = 0; i < 10; i++) {
    const rows = await api.logs({ api_key_id: keyId, limit: 5 });
    if (i === 9 || rows.some((r) => r.created_at >= since - 1500)) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

function statusTone(status: number): 'ok' | 'warn' | 'bad' {
  if (status < 300) return 'ok';
  if (status < 500) return 'warn';
  return 'bad';
}

export function Playground() {
  const modelsQ = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const [pgKey, setPgKey] = useState<PlaygroundKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [logRows, setLogRows] = useState<LogRow[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const models = useMemo(
    () => (modelsQ.data ?? []).filter((m) => m.enabled).sort((a, b) => a.provider_name.localeCompare(b.provider_name) || a.slug.localeCompare(b.slug)),
    [modelsQ.data],
  );
  const selected = models.find((m) => m.slug === model) ?? null;

  // Mint the session key once per mount (api.createPlaygroundKey dedupes
  // StrictMode's double-effect so both mounts share the same key).
  useEffect(() => {
    api.createPlaygroundKey().then(setPgKey).catch((e: Error) => setKeyError(e.message));
  }, []);

  // Default the picker to the first enabled model; keep the choice when the
  // list refetches and the slug still exists.
  useEffect(() => {
    if (!model && models.length) setModel(models[0].slug);
    else if (model && models.length && !models.some((m) => m.slug === model)) setModel(models[0].slug);
  }, [models, model]);

  // Keep the transcript pinned to the newest content while it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !pgKey || !model) return;
    setInput('');
    const history: { role: string; content: string }[] = [];
    const sys = system.trim();
    if (sys) history.push({ role: 'system', content: sys });
    for (const t of turns) {
      if (!t.error && t.content.trim()) history.push({ role: t.role, content: t.content });
    }
    history.push({ role: 'user', content: text });

    const body: Record<string, unknown> = {
      model,
      messages: history,
      stream: true,
      stream_options: { include_usage: true },
    };
    const temp = Number(temperature);
    if (temperature.trim() !== '' && Number.isFinite(temp) && temp >= 0 && temp <= 2) body.temperature = temp;
    const mt = Number(maxTokens);
    if (maxTokens.trim() !== '' && Number.isInteger(mt) && mt >= 1) body.max_tokens = mt;

    const userTurn: Turn = { role: 'user', content: text };
    const assistantTurn: Turn = { role: 'assistant', content: '', streaming: true };
    setTurns((ts) => [...ts, userTurn, assistantTurn]);
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = Date.now();
    try {
      await streamChat(body, pgKey.key, (delta) => {
        setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, content: t.content + delta } : t)));
      }, ctrl.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as Error).name !== 'AbortError') {
        setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, content: msg, error: true } : t)));
      }
    } finally {
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, streaming: false } : t)));
      setStreaming(false);
      abortRef.current = null;
      waitForLogRow(pgKey.id, startedAt).then(setLogRows).catch(() => undefined);
    }
  };

  const stop = () => abortRef.current?.abort();
  const clear = () => {
    if (streaming) stop();
    setTurns([]);
    setLogRows(null);
  };

  const meta = selected
    ? [
        selected.context_window ? `ctx ${fmtTokens(selected.context_window)}` : null,
        selected.pricing_input != null ? `in ${fmtPrice(selected.pricing_input)}/1M` : null,
        selected.pricing_output != null ? `out ${fmtPrice(selected.pricing_output)}/1M` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div>
      <PageHeader
        title="Playground"
        subtitle="Chat with any enabled model through the live /v1 gateway — requests are authenticated, rate-limited and logged exactly like a real client."
        action={
          pgKey ? (
            <Badge tone="ok" title="Session-scoped client key — minted fresh per visit, dies when you sign out.">
              key {pgKey.key_prefix}…
            </Badge>
          ) : keyError ? (
            <Badge tone="bad">key error</Badge>
          ) : (
            <Spinner />
          )
        }
      />

      {!modelsQ.isPending && models.length === 0 ? (
        <Card>
          <EmptyState
            title="No enabled models"
            description="Register a provider and enable at least one model to use the playground."
            action={
              <Link to="/models">
                <Button variant="outline">Go to Models</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <label className="block text-xs font-medium text-zinc-400">Model</label>
                <Select value={model} onChange={(e) => setModel(e.target.value)} disabled={streaming}>
                  {models.map((m: ModelRow) => (
                    <option key={m.id} value={m.slug}>
                      {(m.display_name || m.slug) + (m.provider_name ? ` — ${m.provider_name}` : '')}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-28 space-y-1.5">
                <label className="block text-xs font-medium text-zinc-400">Temperature</label>
                <Input placeholder="default" value={temperature} onChange={(e) => setTemperature(e.target.value)} disabled={streaming} />
              </div>
              <div className="w-28 space-y-1.5">
                <label className="block text-xs font-medium text-zinc-400">Max tokens</label>
                <Input placeholder="default" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} disabled={streaming} />
              </div>
              <Button variant="outline" onClick={clear} disabled={turns.length === 0 && !streaming}>
                Clear
              </Button>
            </div>
            {meta ? <p className="mt-2 text-[11px] text-zinc-500">{meta}</p> : null}
            {keyError ? <p className="mt-2 text-[11px] text-red-400">Failed to mint the playground key: {keyError}</p> : null}
          </Card>

          <Card className="p-4">
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">System prompt (optional)</label>
            <Textarea
              rows={2}
              placeholder="Instructions for the model…"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              disabled={streaming}
            />
          </Card>

          <Card>
            <div ref={scrollRef} className="max-h-[26rem] min-h-40 space-y-3 overflow-y-auto p-4">
              {turns.length === 0 ? (
                <p className="px-2 py-6 text-center text-[13px] text-zinc-500">
                  Send a message to round-trip a streamed chat through the gateway. Enter sends; Shift+Enter adds a newline.
                </p>
              ) : (
                turns.map((t, i) => (
                  <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13px] whitespace-pre-wrap break-words',
                        t.role === 'user'
                          ? 'bg-emerald-500/15 text-emerald-100 ring-1 ring-emerald-500/30'
                          : t.error
                            ? 'bg-red-500/10 text-red-300 ring-1 ring-red-500/40'
                            : 'bg-zinc-800/70 text-zinc-100 ring-1 ring-zinc-700/60',
                      )}
                    >
                      {t.content || (t.streaming ? '▍' : '')}
                      {t.streaming && t.content ? <span className="animate-pulse">▍</span> : null}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-end gap-3 border-t border-zinc-800/80 p-4">
              <Textarea
                rows={2}
                className="flex-1"
                placeholder="Message…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={!pgKey || !model}
              />
              <Button onClick={streaming ? stop : send} variant={streaming ? 'danger' : 'primary'} disabled={!pgKey || !model || (!streaming && !input.trim())}>
                {streaming ? (
                  <>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" /> Send
                  </>
                )}
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-medium text-zinc-400">Request log — this session's key</h2>
              {logRows && logRows.length > 0 ? <span className="text-[11px] text-zinc-600">newest first</span> : null}
            </div>
            {!logRows || logRows.length === 0 ? (
              <p className="text-[12px] text-zinc-600">No requests yet. Each completion appends its request_logs row here (usage, latency, cost).</p>
            ) : (
              <div className="space-y-1.5">
                {logRows.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-zinc-900/60 px-3 py-1.5 text-[12px] text-zinc-400">
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    <span className="font-mono text-zinc-300">{r.model_slug}</span>
                    <span>{r.dialect}</span>
                    <span>
                      {fmtTokens(r.tokens_in)} in / {fmtTokens(r.tokens_out)} out
                    </span>
                    <span>{r.cost_usd != null ? `$${r.cost_usd.toFixed(6)}` : '—'}</span>
                    <span>{r.latency_ms != null ? `${r.latency_ms} ms` : '—'}</span>
                    {r.cache_hit ? <Badge tone="ok">cached</Badge> : null}
                    {r.error ? <span className="text-red-400">{r.error}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
