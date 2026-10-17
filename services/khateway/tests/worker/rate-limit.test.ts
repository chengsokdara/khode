// Golden fixtures + offline coverage for the M10 rate limiter. The fixture
// half pins the gateway check builder (which buckets one request increments);
// the DO half drives the REAL RateLimiterDO.fetch handler against a fake
// SqlStorage (Node's Request/Response stand in for the workerd ones), so
// window math, the allowed boundary, Retry-After source and protocol guards
// are tested without a workerd runtime. smoke_m10 pins the DO end-to-end.
import { describe, expect, it } from 'vitest';
import { buildGatewayRateChecks, loginAllowed, RATE_WINDOW_MS, reserveSpend, settleSpend } from '../../src/worker/ratelimit/client';
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
  reservations: Map<string, { micros: number; updated_at: number }> = new Map();
  exec<T extends Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> {
    if (query.includes('reservations')) {
      if (query.startsWith('INSERT')) {
        const [scope, micros, now] = params as [string, number, number];
        const row = this.reservations.get(scope);
        const next = { micros: (row?.micros ?? 0) + micros, updated_at: now };
        this.reservations.set(scope, next);
        return [{ micros: next.micros }] as unknown as Iterable<T>;
      }
      if (query.startsWith('UPDATE')) {
        const [amount, now, scope] = params as [number, number, string];
        const row = this.reservations.get(scope);
        if (!row) return [] as unknown as Iterable<T>;
        row.micros -= amount;
        row.updated_at = now;
        return [{ micros: row.micros }] as unknown as Iterable<T>;
      }
      if (query.startsWith('DELETE')) {
        if (query.includes('updated_at')) {
          const [before] = params as [number];
          for (const [scope, r] of [...this.reservations]) if (r.updated_at < before) this.reservations.delete(scope);
        } else {
          const [scope] = params as [string];
          this.reservations.delete(scope);
        }
        return [] as unknown as Iterable<T>;
      }
    }
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

describe('loginAllowed through the DO (P2 — cross-isolate login buckets)', () => {
  /** Env stub whose RATE_LIMITER binding drives the REAL DO against a FakeSql. */
  function fakeEnv(do_?: RateLimiterDO, failing = false) {
    const stub = {
      idFromName: (_name: string) => 'global',
      get: (_id: string) => ({
        fetch: async (url: string, init: RequestInit) => {
          if (failing) throw new Error('DO unreachable');
          return do_!.fetch(new Request(url, init));
        },
      }),
    };
    return { RATE_LIMITER: stub } as unknown as Parameters<typeof loginAllowed>[0];
  }

  it('counts per surface + IP in a fixed window and denies past the limit', async () => {
    const env = fakeEnv(new RateLimiterDO({ storage: { sql: new FakeSql() } } as unknown as DurableObjectState, {}));
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await loginAllowed(env, 'admin', '1.2.3.4'));
    expect(results.filter(Boolean).length).toBe(10);
    // separate surface and separate IP are independent buckets
    expect(await loginAllowed(env, 'portal-login', '1.2.3.4')).toBe(true);
    expect(await loginAllowed(env, 'admin', '5.6.7.8')).toBe(true);
  });

  it('fails OPEN when the DO is unreachable', async () => {
    expect(await loginAllowed(fakeEnv(undefined, true), 'admin', '1.2.3.4')).toBe(true);
  });
});

describe('spend reservations in the DO (P4)', () => {
  function wiredEnv() {
    const do_ = new RateLimiterDO({ storage: { sql: new FakeSql() } } as unknown as DurableObjectState, {});
    const stub = {
      idFromName: (_name: string) => 'global',
      get: (_id: string) => ({
        fetch: (url: string, init: RequestInit) => do_.fetch(new Request(url, init)),
      }),
    };
    return { RATE_LIMITER: stub } as unknown as Parameters<typeof reserveSpend>[0];
  }

  it('reserves accumulate per scope and settle release them', async () => {
    const env = wiredEnv();
    expect(await reserveSpend(env, 'reserve:key:a', 500)).toBe(500);
    expect(await reserveSpend(env, 'reserve:key:a', 250)).toBe(750);
    expect(await reserveSpend(env, 'reserve:key:b', 10)).toBe(10); // independent scope
    await settleSpend(env, 'reserve:key:a', 250);
    expect(await reserveSpend(env, 'reserve:key:a', 0 + 0 + 1)).toBe(501); // 750 - 250 + 1
    await settleSpend(env, 'reserve:key:a', 10_000); // over-settle clamps at 0
    expect(await reserveSpend(env, 'reserve:key:a', 7)).toBe(7);
  });

  it('rejects malformed reserves and fails open when the DO is unreachable', async () => {
    const do_ = new RateLimiterDO({ storage: { sql: new FakeSql() } } as unknown as DurableObjectState, {});
    const bad = await do_.fetch(new Request('https://rate-limiter.internal/reserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'x', micros: -5 }) }));
    expect(bad.status).toBe(400);
    const failing = {
      RATE_LIMITER: {
        idFromName: () => 'global',
        get: () => ({ fetch: async () => { throw new Error('down'); } }),
      },
    } as unknown as Parameters<typeof reserveSpend>[0];
    expect(await reserveSpend(failing, 'reserve:key:a', 500)).toBeNull(); // fail-open
    await expect(settleSpend(failing, 'reserve:key:a', 500)).resolves.toBeUndefined(); // never throws
  });
});
