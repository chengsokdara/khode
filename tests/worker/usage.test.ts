// Golden fixtures for M7 usage/cost extraction: non-stream JSON bodies, the
// tee'd SSE watcher (openai chunk usage / anthropic message_start +
// message_delta), the tee'd JSON branch, and the costUsd snapshot semantics
// (null pricing ≠ free).
import { describe, expect, it } from 'vitest';
import { costUsd, usageFromJsonBody, watchUpstreamJsonUsage, watchUpstreamSseUsage } from '../../src/worker/dialects/usage';
import { loadFixtures, sseSource, sseText } from './helpers';

describe('usage extraction (golden)', () => {
  for (const case_ of loadFixtures('usage.json')) {
    it(`${case_.fn as string}: ${case_.name as string}`, async () => {
      const upstream = case_.upstream as 'openai' | 'anthropic';
      switch (case_.fn) {
        case 'json':
          expect(usageFromJsonBody(upstream, case_.payload as Record<string, unknown>)).toEqual(case_.expected);
          break;
        case 'cost':
          expect(
            costUsd(
              (case_.pricingIn as number | null) ?? null,
              (case_.pricingOut as number | null) ?? null,
              (case_.usage as { tokensIn: number | null; tokensOut: number | null } | null) ?? null,
            ),
          ).toEqual(case_.expected);
          break;
        case 'sse': {
          const input = case_.raw !== undefined ? (case_.raw as string) : sseText(case_.inputEvents as { event?: string; data: unknown }[]);
          const usage = await watchUpstreamSseUsage(upstream, sseSource(input));
          expect(usage).toEqual(case_.expected);
          break;
        }
        case 'watchJson': {
          const body = sseSource(JSON.stringify(case_.payload));
          expect(await watchUpstreamJsonUsage(upstream, body)).toEqual(case_.expected);
          break;
        }
      }
    });
  }
});
