// Golden fixtures for the SSE translators — the M4/M5/M6 streaming matrix:
// anthropic events → openai chunks, openai chunks → anthropic events, and
// both upstreams → Responses event sequences. Cases:
// tests/fixtures/translate-sse.json. Fixture input events are serialized to
// real wire format (event:/data: framing); output is parsed back and compared
// structurally with wall-clock created/created_at frozen to "<now>".
import { describe, expect, it } from 'vitest';
import { transformOpenAiSseToAnthropic } from '../../src/worker/dialects/anthropicMessages';
import { transformAnthropicSseToOpenAi } from '../../src/worker/dialects/openaiChat';
import { transformAnthropicSseToResponses, transformOpenAiSseToResponses } from '../../src/worker/dialects/openaiResponses';
import { freezeTimestamps, loadFixtures, parseSse, sseSource, sseText, streamText, type ParsedSse } from './helpers';

const translators = {
  anthropicToOpenAi: transformAnthropicSseToOpenAi,
  openAiToAnthropic: transformOpenAiSseToAnthropic,
  openAiToResponses: transformOpenAiSseToResponses,
  anthropicToResponses: transformAnthropicSseToResponses,
} as const;

describe('sse translation (golden)', () => {
  for (const case_ of loadFixtures('translate-sse.json')) {
    const translate = translators[case_.translator as keyof typeof translators];
    it(`${case_.translator}: ${case_.name as string}`, async () => {
      const input = sseText(case_.inputEvents as { event?: string; data: unknown }[]);
      // Optional per-dialect translator options ride in `opts` (e.g. the openai
      // include_usage contract for the anthropic→openai translator).
      const opts = (case_.opts ?? {}) as Record<string, unknown>;
      const output = await streamText(translate(sseSource(input), case_.model as string, opts));
      const actual: ParsedSse[] = parseSse(output).map((ev) => ({ event: ev.event, data: freezeTimestamps(ev.data) }));
      const expected = (case_.expected as { event?: string; data: unknown }[]).map((ev) => ({
        event: ev.event ?? '',
        data: ev.data,
      }));
      expect(actual).toEqual(expected);
    });
  }
});
