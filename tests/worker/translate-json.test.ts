// Golden fixtures for the JSON response translators (M4 cross-dialect half:
// openai ↔ anthropic; M5: both upstreams → Responses objects). Cases:
// tests/fixtures/translate-json.json. Timestamps emitted from Date.now() are
// frozen to "<now>"; when the upstream payload carries `created` the value
// must pass through (case "tool-only turn" pins a literal 1726500000).
import { describe, expect, it } from 'vitest';
import { openAiCompletionToAnthropicMessage } from '../../src/worker/dialects/anthropicMessages';
import { anthropicMessageToOpenAiCompletion } from '../../src/worker/dialects/openaiChat';
import { anthropicMessageToResponse, openAiCompletionToResponse } from '../../src/worker/dialects/openaiResponses';
import { freezeTimestamps, loadFixtures } from './helpers';

const translators = {
  anthropicToOpenAi: anthropicMessageToOpenAiCompletion,
  openAiToAnthropic: openAiCompletionToAnthropicMessage,
  openAiToResponse: openAiCompletionToResponse,
  anthropicToResponse: anthropicMessageToResponse,
} as const;

describe('json response translation (golden)', () => {
  for (const case_ of loadFixtures('translate-json.json')) {
    const translate = translators[case_.translator as keyof typeof translators];
    it(`${case_.translator}: ${case_.name as string}`, () => {
      const result = translate(
        case_.payload as Record<string, unknown>,
        case_.model as string,
      ) as Record<string, unknown>;
      expect(freezeTimestamps(result)).toEqual(case_.expected);
    });
  }

  it('openAiToResponse: upstream `created` epoch passes through verbatim', () => {
    const result = openAiCompletionToResponse(
      { id: 'chatcmpl-TS', created: 1726500000, choices: [], usage: {} },
      'gpt-5',
    );
    expect(result.created_at).toBe(1726500000);
  });
});
