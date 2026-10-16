// P3: fallback backoff + Retry-After honoring — golden fixtures pin the
// pure retry decision (same-upstream retry once, strictly budgeted waits);
// the Retry-After header parser and the sleep helper are covered inline.
import { describe, expect, it } from 'vitest';
import { MAX_SINGLE_WAIT_MS, parseRetryAfterSeconds, retryDecision, sleep } from '../../src/worker/backoff';
import { loadFixtures } from './helpers';

describe('retryDecision (golden)', () => {
  for (const case_ of loadFixtures('backoff.json')) {
    it(case_.name as string, () => {
      expect(retryDecision(case_.input as Parameters<typeof retryDecision>[0])).toEqual(case_.expected);
    });
  }
});

describe('parseRetryAfterSeconds', () => {
  it('reads delta-seconds and rejects garbage', () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds('')).toBeNull();
    expect(parseRetryAfterSeconds(' 7 ')).toBe(7);
    expect(parseRetryAfterSeconds('soon')).toBeNull();
    expect(parseRetryAfterSeconds('-3')).toBeNull();
  });
  it('reads HTTP-dates relative to now', () => {
    const future = new Date(Date.now() + 60 * 1000).toUTCString();
    const got = parseRetryAfterSeconds(future);
    expect(got).not.toBeNull();
    expect(got as number).toBeGreaterThanOrEqual(55);
    expect(got as number).toBeLessThanOrEqual(61);
    const past = new Date(Date.now() - 60 * 1000).toUTCString();
    expect(parseRetryAfterSeconds(past)).toBe(0);
  });
});

describe('sleep', () => {
  it('resolves (roughly) after the asked delay', async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
  it('exposes the documented caps', () => {
    expect(MAX_SINGLE_WAIT_MS).toBe(4_000);
  });
});
