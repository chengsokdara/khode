// Golden fixtures for the Lemon Squeezy webhook surface (M8): payload →
// LsWebhookEvent parsing and the credit-micros math (prepaid product value =
// subtotal − discount, total fallback; zero for anything not a paid,
// non-refunded order_created).
import { describe, expect, it } from 'vitest';
import { creditMicros, parseLsWebhook } from '../../src/worker/billing/lemonsqueezy';
import { loadFixtures } from './helpers';

describe('lemonsqueezy webhook parsing + credit math (golden)', () => {
  for (const case_ of loadFixtures('billing-lemonsqueezy.json')) {
    it(case_.name as string, () => {
      const ev = parseLsWebhook(case_.payload);
      expect(ev).toEqual(case_.expected);
      expect(ev && creditMicros(ev)).toBe(case_.creditMicros);
    });
  }

  it('rejects non-object bodies', () => {
    expect(parseLsWebhook(null)).toBeNull();
    expect(parseLsWebhook('nope')).toBeNull();
    expect(parseLsWebhook([1, 2])).toBeNull();
    expect(parseLsWebhook({ meta: { event_name: 'order_created' } })).toBeNull(); // no data.id
    expect(parseLsWebhook({ data: { id: '1' } })).toBeNull(); // no event_name
  });
});
