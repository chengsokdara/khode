// Golden fixtures for the upstream adapters (M3 openai, M4 anthropic): the
// exact wire requests built from the canonical form — URL, headers (auth
// shape, default_headers merge, anthropic-version), full body, and the
// clamped timeout budget. Fixture keys marked "RUNTIME" are encrypted at test
// time with a throwaway ENCRYPTION_KEY (ciphertexts embed a random IV and
// cannot be pre-baked); UnsupportedTranslation/UpstreamMisconfig errors are
// pinned by message fragment.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/env';
import type { CanonicalChatRequest } from '../../src/worker/canonical';
import { buildAnthropicMessagesRequest } from '../../src/worker/adapters/anthropic';
import { buildOpenAiChatRequest } from '../../src/worker/adapters/openai';
import { buildGeminiGenerateContentRequest } from '../../src/worker/adapters/gemini';
import { UnsupportedTranslationError, UpstreamMisconfigError } from '../../src/worker/adapters/base';
import { encryptSecret } from '../../src/worker/crypto';
import type { RoutingCandidate } from '../../src/worker/routing';
import { loadFixtures, makeCandidate, TEST_ENCRYPTION_KEY, type FixtureCase } from './helpers';

const env = { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as Env;

describe('adapter request building (golden)', () => {
  // adapters.json holds the openai + anthropic cases; gemini-adapter.json the
  // native Gemini ones (M12) — same case shape, same builder dispatch.
  for (const case_ of [...loadFixtures('adapters.json'), ...loadFixtures('gemini-adapter.json')]) {
    const c = case_ as FixtureCase;
    it(`${c.adapter as string}: ${c.name as string}`, async () => {
      const cand: RoutingCandidate = makeCandidate(
        c.cand as Parameters<typeof makeCandidate>[0],
      );

      // Runtime-encrypt the fixture's plaintext key where requested; literal
      // apiKeyEnc values (misconfig cases) arrive via makeCandidate.
      if (c.apiKeyPlain) {
        cand.provider.apiKeyEnc = (await encryptSecret(env, c.apiKeyPlain as string)) as string;
      }

      const req = c.req as CanonicalChatRequest;
      const build =
        c.adapter === 'openai'
          ? buildOpenAiChatRequest
          : c.adapter === 'gemini'
            ? buildGeminiGenerateContentRequest
            : buildAnthropicMessagesRequest;

      if (c.error === 'unsupported' || c.error === 'misconfig') {
        const probe = build(env, cand, req);
        await expect(probe).rejects.toThrow(
          c.error === 'unsupported' ? UnsupportedTranslationError : UpstreamMisconfigError,
        );
        await expect(probe).rejects.toThrow(c.messageContains as string);
        return;
      }

      const built = await build(env, cand, req);
      const expected = c.expected as { url: string; headers: Record<string, string>; body: Record<string, unknown>; timeoutMs: number };

      expect(built.url).toBe(expected.url);
      expect(built.headers).toEqual(expected.headers);
      expect(JSON.parse(built.body)).toEqual(expected.body);
      expect(built.timeoutMs).toBe(expected.timeoutMs);
    });
  }
});
