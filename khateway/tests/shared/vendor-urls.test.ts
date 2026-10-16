// Unit tests for the shared vendor URL presets: pure data, no DB/HTTP.
// Verifies structural invariants that the UI and adapters rely on. The /v1
// joining rules themselves are pinned in tests/worker/join-adapter-url.test.ts.
import { describe, expect, it } from 'vitest';
import { VENDOR_PRESETS } from '../../src/shared/vendor-urls';

describe('vendor URL presets', () => {
  it('has unique vendor names and absolute https/http URLs', () => {
    const names = VENDOR_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of VENDOR_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.adapters.length).toBeGreaterThanOrEqual(1);
      expect(p.hint.length).toBeGreaterThan(0);
    }
  });

  it('no base URL ends in a slash (adapters join paths themselves)', () => {
    for (const p of VENDOR_PRESETS) {
      expect(p.baseUrl.endsWith('/')).toBe(false);
    }
  });

  it('dual-dialect entries use the openai /v1 convention so joinAdapterUrl serves both', () => {
    for (const p of VENDOR_PRESETS.filter((p) => p.adapters.length === 2)) {
      expect(p.baseUrl).toMatch(/\/v1$/);
    }
  });

  it('single-anthropic entries have no /v1 (bare origin convention)', () => {
    for (const p of VENDOR_PRESETS.filter((p) => p.adapters.length === 1 && p.adapters[0] === 'anthropic')) {
      expect(p.baseUrl).not.toMatch(/\/v1$/);
    }
  });

  it('includes the verified dual-dialect vendors (OpenRouter, LiteLLM)', () => {
    const byName = new Map(VENDOR_PRESETS.map((p) => [p.name, p]));
    expect(byName.get('OpenRouter')).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      adapters: ['openai', 'anthropic'],
    });
    expect(byName.get('LiteLLM proxy')).toMatchObject({
      adapters: ['openai', 'anthropic'],
    });
  });
});
