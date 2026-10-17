// Golden fixtures for the three client-dialect request parsers
// (M3 openai chat, M4 anthropic messages, M5 openai responses).
// Cases: tests/fixtures/parse-*.json — each locks a parse result (canonical
// shape or the exact 400 envelope fields) so wire-format regressions surface
// as diffs.
import { describe, expect, it } from 'vitest';
import { parseAnthropicMessagesRequest } from '../../src/worker/dialects/anthropicMessages';
import { parseOpenAiChatRequest } from '../../src/worker/dialects/openaiChat';
import { parseOpenAiResponsesRequest } from '../../src/worker/dialects/openaiResponses';
import { loadFixtures, readerOf, type FixtureCase } from './helpers';

type ParseFn = (reader: { json: () => Promise<unknown> }) => Promise<unknown>;

const suites: { fixtures: string; parse: ParseFn }[] = [
  { fixtures: 'parse-openai-chat.json', parse: parseOpenAiChatRequest },
  { fixtures: 'parse-anthropic-messages.json', parse: parseAnthropicMessagesRequest },
  { fixtures: 'parse-openai-responses.json', parse: parseOpenAiResponsesRequest },
];

for (const suite of suites) {
  const dialect = suite.fixtures.replace('parse-', '').replaceAll('-', ' ');
  describe(`parse: ${dialect}`, () => {
    for (const case_ of loadFixtures(suite.fixtures)) {
      it(case_.name as string, async () => {
        const result = (await suite.parse(readerOf(case_))) as Record<string, unknown>;
        expect(result).toEqual((case_ as FixtureCase).expected);
      });
    }
  });
}
