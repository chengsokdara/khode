// Golden fixtures for the native Gemini adapter (M12): the gemini→openai
// response normalization (JSON + SSE — the gateway feeds these shapes through
// the existing openai→anthropic / openai→responses translators) and the
// Gemini error-envelope mapping. Request-build goldens live in
// gemini-adapter.json (driven by adapters.test.ts); usageMetadata extraction
// goldens live in usage.json.
import { describe, expect, it } from 'vitest';
import { geminiCompletionToOpenAi, geminiErrorToOpenAi, transformGeminiSseToOpenAi } from '../../src/worker/dialects/gemini';
import { freezeTimestamps, loadFixtures, parseSse, sseSource, sseText, streamText, type FixtureCase } from './helpers';

describe('gemini → openai JSON normalize (golden)', () => {
  for (const c of loadFixtures('gemini-translation.json')) {
    const case_ = c as FixtureCase;
    if (case_.fn === 'json') {
      it(`json: ${case_.name as string}`, () => {
        expect(freezeTimestamps(geminiCompletionToOpenAi(case_.payload as Record<string, unknown>, case_.model as string))).toEqual(
          case_.expected,
        );
      });
    } else if (case_.fn === 'error') {
      it(`error: ${case_.name as string}`, () => {
        expect(geminiErrorToOpenAi(case_.status as number, case_.raw as string)).toEqual(case_.expected);
      });
    }
  }
});

describe('gemini → openai SSE normalize (golden)', () => {
  for (const c of loadFixtures('gemini-sse.json')) {
    const case_ = c as FixtureCase;
    it(`sse: ${case_.name as string}`, async () => {
      const input = case_.raw !== undefined ? (case_.raw as string) : sseText(case_.inputEvents as { event?: string; data: unknown }[]);
      const out = await streamText(
        transformGeminiSseToOpenAi(sseSource(input), case_.model as string, { includeUsage: case_.includeUsage === true }),
      );
      expect(freezeTimestamps(parseSse(out))).toEqual(case_.expected);
    });
  }
});
