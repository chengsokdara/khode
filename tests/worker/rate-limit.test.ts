// Golden fixtures + offline coverage for the M10 rate limiter. The fixture
// half pins the gateway check builder (which buckets one request increments);
// the DO half drives the REAL RateLimiterDO.fetch handler against a fake
// SqlStorage (Node's Request/Response stand in for the workerd ones), so
// window math, the allowed boundary, Retry-After source and protocol guards
// are tested without a workerd runtime. smoke_m10 pins the DO end-to-end.
import { describe, expect, it } from 'vitest';
import { buildGatewayRateChecks, RATE_WINDOW_MS } from '../../src/worker/ratelimit/client';
import { RateLimiterDO, type RateCheck } from '../../src/worker/ratelimit/do';
import { loadFixtures } from './helpers';

describe('gateway rate-check builder (golden)', () => {
  for (const case_ of loadFixtures('rate-limit-checks.json')) {
    it(case_.name as string, () => {
      expect(buildGatewayRateChecks(case_.input as Parameters<typeof buildGatewayRateChecks>[0])).toEqual(case_.expected);
    });
  }
});

/** Minimal SqlStorage fake running the same upsert/evict SQL the DO issues. */
class FakeSql {
  rows: { scope: string; window_start: number; count: number }[] = [];
  exec<T extends Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> {
    if (query.startsWith('INSERT')) {
      const [scope, windowStart] = params as [string, number];
      let row = this.rows.find((r) => r.scope === scope && r.window_start === windowStart);
      if (row) row.count += 1;
      else {
        row = { scope, window_start: windowStart, count: 1 };
        this.rows.push(row);
      }
      return [{ count: row.count }] as unknown as Iterable<T>;
    }
    if (query.startsWith('DELETE')) {
      const [before] = params as [number];
      this.rows = this.rows.filter((r) => r.window_start >= before);
      return [] as unknown as Iterable<T>;
    }
    if (query.startsWith('CREATE')) return [] as unknown as Iterable<T>;
    throw new Error(`FakeSql: unexpected query ${query}`);
  }
}

/** A RateLimiterDO wired to a FakeSql through a minimal DurableObjectState. */
function makeDo() {
  const sql = new FakeSql();
  const do_ = new RateLimiterDO({ storage: { sql } } as unknown as DurableObjectState, {});
  const check = async (checks: RateCheck[]): Promise<{ status: number; results: { kind: string; scope: string; limit: number; allowed: boolean; count: number; resetAfterMs: number }[] }> => {
    const res = await do_.fetch(new Request('https://rate-limiter.internal/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checks }) }));
    return { status: res.status, results: ((await res.json()) as { results: never[] }).results };
  };
  return { check, sql };
}

describe('RateLimiterDO fixed-window semantics', () => {
  const T0 = 1_760_000_000_000; // aligns to a 60s window boundary

  it('counts up and denies the (limit+1)-th request within a window', async () => {
    const { check } = makeDo();
    const bucket: RateCheck = { kind: 'key', scope: 'key:x', limit: 3, windowMs: RATE_WINDOW_MS };
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await check([bucket])).results[0]);
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2].count).toBe(3);
    expect(results[3].count).toBe(4);
    expect(results[3].limit).toBe(3);
  });

  it('reports resetAfterMs bounded by the window (Retry-After source)', async () => {
    const { check } = makeDo();
    const results = (await check([{ kind: 'ip', scope: 'ip:1.2.3.4', limit: 5, windowMs: RATE_WINDOW_MS }])).results;
    expect(results[0].resetAfterMs).toBeGreaterThan(0);
    expect(results[0].resetAfterMs).toBeLessThanOrEqual(RATE_WINDOW_MS);
  });

  it('denies per-scope independently (key vs key, model vs key)', async () => {
    const { check } = makeDo();
    const a: RateCheck = { kind: 'key', scope: 'key:a', limit: 1, windowMs: RATE_WINDOW_MS };
    const b: RateCheck = { kind: 'key', scope: 'key:b', limit: 1, windowMs: RATE_WINDOW_MS };
    expect((await check([a])).results[0].allowed).toBe(true);
    expect((await check([a])).results[0].allowed).toBe(false);
    expect((await check([b])).results[0].allowed).toBe(true);
    expect((await check([{ ...a, scope: 'model:shared' }])).results[0].allowed).toBe(true);
  });

  it('denies immediately when several buckets are checked together', async () => {
    const { check } = makeDo();
    const key: RateCheck = { kind: 'key', scope: 'key:c', limit: 10, windowMs: RATE_WINDOW_MS };
    const model: RateCheck = { kind: 'model', scope: 'model:hot', limit: 2, windowMs: RATE_WINDOW_MS };
    expect((await check([key, model])).results[1].allowed).toBe(true);
    expect((await check([key, model])).results[1].allowed).toBe(true);
    const third = await check([key, model]);
    expect(third.results[0].allowed).toBe(true); // key fine at 3/10
    expect(third.results[1].allowed).toBe(false); // model tripped at 3/2
  });

  it('malformed checks fail open and wrong routes 404', async () => {
    const do_ = new RateLimiterDO({ storage: { sql: new FakeSql() } } as unknown as DurableObjectState, {});
    const bad = await do_.fetch(new Request('https://rate-limiter.internal/check', { method: 'POST', body: JSON.stringify({ checks: [{ scope: 'x' }] }) }));
    expect(bad.status).toBe(200);
    const body = (await bad.json()) as { results: { allowed: boolean }[] };
    expect(body.results[0].allowed).toBe(true); // malformed → allowed, never throws
    const wrong = await do_.fetch(new Request('https://rate-limiter.internal/nope', { method: 'POST', body: '{}' }));
    expect(wrong.status).toBe(404);
    const get = await do_.fetch(new Request('https://rate-limiter.internal/check', { method: 'GET' }));
    expect(get.status).toBe(404);
  });
});
