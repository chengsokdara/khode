// RateLimiterDO (M10): the cross-isolate rate-limit counter. Cloudflare Workers
// requests are served by many isolates, so the in-memory `loginAllowed`
// buckets in auth.ts cannot bound the gateway — every /v1 request funnels
// through ONE instance of this Durable Object (name "global") instead.
//
// Why a Durable Object and not a D1 counter: a D1 upsert would add one D1
// write PER gateway request — doubling the per-request write load (request_logs
// already writes one row) and burning the D1 free-tier write budget on
// counting. The DO keeps counters in its co-located SQLite storage (available
// on the Workers free plan via `new_sqlite_classes`), is atomic by
// construction (single-threaded instance; the read-increment runs without an
// await in between), and costs one sub-millisecond RPC per request.
//
// Fixed 1-minute windows (`counters` keyed by scope + window start): simple,
// predictable Retry-After values, at the cost of allowing up to 2× the limit
// across a window boundary — the standard fixed-window tradeoff, fine for
// abuse control (not a billing guarantee).
//
// Protocol (internal fetch, deliberately not RPC so the class stays a plain
// ES class — no `cloudflare:workers` import, clean under tsc and vitest):
//   POST /check  { checks: [{ kind, scope, limit, windowMs }] }
//   →            { results: [{ kind, scope, limit, allowed, count, resetAfterMs }] }
// Every check is INCREMENTED even when a later check denies — a rejected
// request still counts toward its other buckets. That over-count is the
// standard, safe direction for rate limiting.
export class RateLimiterDO {
  private readonly sql: SqlStorage;
  private tableReady = false;
  private calls = 0;

  constructor(state: DurableObjectState, _env: unknown) {
    this.sql = state.storage.sql;
  }

  private ensureTable(): void {
    if (this.tableReady) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (
         scope TEXT NOT NULL,
         window_start INTEGER NOT NULL,
         count INTEGER NOT NULL,
         PRIMARY KEY (scope, window_start)
       )`,
    );
    this.tableReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/check') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    let checks: unknown;
    try {
      checks = (await request.json() as { checks?: unknown }).checks;
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (!Array.isArray(checks)) {
      return Response.json({ error: 'checks must be an array' }, { status: 400 });
    }

    this.ensureTable();
    const now = Date.now();
    const results: RateLimitDecision[] = [];
    for (const raw of checks) {
      const c = raw as Partial<RateCheck>;
      // Invalid checks fail OPEN (treated as no limit) — a malformed bucket
      // must never take the gateway down; the client validates inputs anyway.
      if (typeof c.scope !== 'string' || !c.scope || typeof c.limit !== 'number' || !Number.isFinite(c.limit) || c.limit < 1 || typeof c.windowMs !== 'number' || !Number.isFinite(c.windowMs) || c.windowMs < 1_000) {
        results.push({ kind: c.kind ?? 'unknown', scope: String(c.scope ?? ''), limit: 0, allowed: true, count: 0, resetAfterMs: 0 });
        continue;
      }
      const limit = Math.floor(c.limit);
      const windowMs = Math.floor(c.windowMs);
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const rows = [
        ...this.sql.exec(
          `INSERT INTO counters (scope, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT (scope, window_start) DO UPDATE SET count = count + 1
           RETURNING count`,
          c.scope,
          windowStart,
        ),
      ];
      const count = Number(rows[0]?.count ?? 1);
      results.push({
        kind: c.kind ?? 'unknown',
        scope: c.scope,
        limit,
        allowed: count <= limit,
        count,
        resetAfterMs: windowStart + windowMs - now,
      });
    }

    // Amortized eviction: windows are ≤ 5 min long in practice (M10 uses
    // 60 s), so anything older than 10 minutes is dead weight. A small table
    // scan every 50th call keeps the storage bounded without a per-request cost.
    if (++this.calls % 50 === 0) {
      this.sql.exec('DELETE FROM counters WHERE window_start < ?', now - 600_000);
    }

    return Response.json({ results });
  }
}

/** One bucket to increment — built by ratelimit/client.ts buildGatewayRateChecks. */
export interface RateCheck {
  /** Human-facing bucket kind, echoed in the decision for error messages. */
  kind: 'key' | 'ip' | 'model' | string;
  /** Namespaced counter key, e.g. `key:<id>`, `ip:<addr>`, `model:<slug>`. */
  scope: string;
  /** Max requests per window; ≥ 1. */
  limit: number;
  /** Window length in ms (M10: 60_000). */
  windowMs: number;
}

/** What the DO answers per check. */
export interface RateLimitDecision {
  kind: string;
  scope: string;
  limit: number;
  allowed: boolean;
  /** Incremented count this window (already includes the current request). */
  count: number;
  /** Ms until the current window rolls over (for Retry-After). */
  resetAfterMs: number;
}
