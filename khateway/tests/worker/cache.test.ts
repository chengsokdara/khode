// Golden fixtures + offline coverage for the M11 semantic cache. The key
// half pins the stable-JSON projection (the reviewable artifact — the cache
// key is its sha-256) plus the identity/ordering properties the dedupe relies
// on; the eligibility half pins the M11 text-only scope gate. The D1 store
// side is covered end-to-end by smoke_m11 (needs a real D1 + HTTP pipeline).
import { describe, expect, it } from 'vitest';
import { buildCacheKey, cacheKeyInput, evaluateCacheEligibility, stableStringify } from '../../src/worker/cache/key';
import type { CanonicalChatRequest } from '../../src/worker/canonical';
import { loadFixtures } from './helpers';

describe('cache key builder (golden)', () => {
  for (const case_ of loadFixtures('cache-keys.json')) {
    it(case_.name as string, async () => {
      const request = case_.request as CanonicalChatRequest;
      expect(stableStringify(cacheKeyInput(request, case_.modelSlug as string))).toBe(case_.expectedStableJson);
      // The published key is exactly sha-256 over the pinned projection —
      // re-hash the parsed golden and demand the same digest.
      const golden = case_.expectedStableJson as string;
      const fromRequest = await buildCacheKey(request, case_.modelSlug as string);
      const fromGolden = await buildCacheKey(JSON.parse(golden) as unknown as CanonicalChatRequest, case_.modelSlug as string);
      expect(fromRequest).toBe(fromGolden);
      expect(fromRequest).toMatch(/^[0-9a-f]{64}$/);
    });
  }
});

describe('cache key properties', () => {
  const base = {
    messages: [{ role: 'user', content: 'Hello', extra: {} }],
    stream: false,
    options: { temperature: 0.7 },
    extras: {},
  } as CanonicalChatRequest;

  it('same request through different property order → same key', async () => {
    const permuted = {
      extras: {},
      options: { temperature: 0.7 },
      stream: false,
      messages: [{ extra: {}, content: 'Hello', role: 'user' }],
    } as CanonicalChatRequest;
    expect(await buildCacheKey(permuted, 'gpt-5')).toBe(await buildCacheKey(base, 'gpt-5'));
  });

  it('stream flags never change the key (only non-streaming requests are cached anyway)', async () => {
    const streaming = { ...base, stream: true, streamIncludeUsage: true } as CanonicalChatRequest;
    expect(await buildCacheKey(streaming, 'gpt-5')).toBe(await buildCacheKey(base, 'gpt-5'));
  });

  it('a changed option, message or model changes the key', async () => {
    const hotter = { ...base, options: { temperature: 0.8 } } as CanonicalChatRequest;
    const longer = { ...base, messages: [{ role: 'user', content: 'Hello!', extra: {} }] } as CanonicalChatRequest;
    expect(await buildCacheKey(hotter, 'gpt-5')).not.toBe(await buildCacheKey(base, 'gpt-5'));
    expect(await buildCacheKey(longer, 'gpt-5')).not.toBe(await buildCacheKey(base, 'gpt-5'));
    expect(await buildCacheKey(base, 'other-model')).not.toBe(await buildCacheKey(base, 'gpt-5'));
  });
});

describe('cache eligibility gate (golden)', () => {
  for (const case_ of loadFixtures('cache-eligibility.json')) {
    it(case_.name as string, () => {
      const request = case_.request as CanonicalChatRequest;
      expect(evaluateCacheEligibility(request, { optedIn: case_.optedIn as boolean })).toEqual(case_.expected);
    });
  }
});
