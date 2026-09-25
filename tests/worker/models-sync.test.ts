// Free-models sync — golden fixtures pin the pure halves: the free filter
// (verified zero pricing / `:free` suffix / gemini free-tier), the per-adapter
// listing merge, and the catalog diff (creates vs metadata updates vs
// enable/disable vs skips — sync-owned rows only). perTokenToPerMillion
// (discovery pricing capture) is covered inline.
import { describe, expect, it } from 'vitest';
import { isFreeUpstreamModel, planSyncUpserts, selectSyncEntries } from '../../src/worker/models-sync';
import type { SyncExistingModel } from '../../src/worker/models-sync';
import type { Adapter } from '../../src/worker/env';
import type { UpstreamModel } from '../../src/worker/discovery';
import { perTokenToPerMillion } from '../../src/worker/discovery';
import { loadFixtures } from './helpers';

const bySuite = (suite: string) => loadFixtures('models-sync.json').filter((c) => c.suite === suite);

describe('isFreeUpstreamModel (golden)', () => {
  for (const case_ of bySuite('free')) {
    it(case_.name as string, () => {
      expect(isFreeUpstreamModel(case_.model as UpstreamModel, case_.adapter as Adapter)).toBe(case_.expected);
    });
  }
});

describe('selectSyncEntries (golden)', () => {
  for (const case_ of bySuite('select')) {
    it(case_.name as string, () => {
      const listings = (case_.listings as { adapter: Adapter; models: UpstreamModel[] }[]).map((l) => ({
        adapter: l.adapter,
        models: l.models,
      }));
      const got = selectSyncEntries(listings);
      expect(got.map((m) => m.id)).toEqual(case_.expectedIds);
      if (Array.isArray(case_.expectedDisplayNames)) {
        expect(got.map((m) => m.displayName)).toEqual(case_.expectedDisplayNames);
      }
    });
  }
});

describe('planSyncUpserts (golden)', () => {
  for (const case_ of bySuite('plan')) {
    it(case_.name as string, () => {
      const got = planSyncUpserts(
        case_.providerId as string,
        case_.entries as UpstreamModel[],
        case_.existing as SyncExistingModel[],
      );
      expect(got).toEqual(case_.expected);
    });
  }
});

describe('perTokenToPerMillion', () => {
  it('converts OpenRouter per-token strings to USD per 1M', () => {
    expect(perTokenToPerMillion('0')).toBe(0);
    expect(perTokenToPerMillion('0.0000015')).toBe(1.5);
    expect(perTokenToPerMillion('1e-9')).toBe(0.001);
  });
  it('rejects non-string / non-finite / negative values as no-pricing', () => {
    expect(perTokenToPerMillion(undefined)).toBeNull();
    expect(perTokenToPerMillion(0)).toBeNull(); // numbers are not the wire shape
    expect(perTokenToPerMillion('')).toBeNull();
    expect(perTokenToPerMillion('free')).toBeNull();
    expect(perTokenToPerMillion('-0.000001')).toBeNull();
  });
});
