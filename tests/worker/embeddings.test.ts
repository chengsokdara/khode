// Golden fixtures for the M13 embeddings surface: the openai/gemini upstream
// request builders (embeddings-adapter.json — same case shape as
// gemini-adapter.json), the /v1/embeddings client parser and the
// gemini→openai embeddings response normalizer (embeddings-openai.json).
// Gateway orchestration (routing/gates/logging) stays covered by the smoke
// suite, per the fixture-suite convention.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/worker/env';
import type { CanonicalEmbeddingsRequest } from '../../src/worker/canonical';
import { buildOpenAiEmbeddingsRequest } from '../../src/worker/adapters/openai';
import { buildGeminiEmbeddingsRequest } from '../../src/worker/adapters/gemini';
import { floatsToBase64, geminiEmbeddingsToOpenAi } from '../../src/worker/dialects/gemini';
import { parseOpenAiEmbeddingsRequest } from '../../src/worker/dialects/openaiEmbeddings';
import { encryptSecret } from '../../src/worker/crypto';
import type { RoutingCandidate } from '../../src/worker/routing';
import { loadFixtures, makeCandidate, readerOf, TEST_ENCRYPTION_KEY, type FixtureCase } from './helpers';

const env = { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as Env;

describe('embeddings adapter request building (golden)', () => {
  for (const case_ of loadFixtures('embeddings-adapter.json')) {
    const c = case_ as FixtureCase;
    it(`${c.adapter as string}: ${c.name as string}`, async () => {
      const cand: RoutingCandidate = makeCandidate(c.cand as Parameters<typeof makeCandidate>[0]);
      if (c.apiKeyPlain) {
        cand.provider.apiKeyEnc = (await encryptSecret(env, c.apiKeyPlain as string)) as string;
      }
      const build =
        c.adapter === 'openai-embeddings' ? buildOpenAiEmbeddingsRequest : buildGeminiEmbeddingsRequest;
      const built = await build(env, cand, c.req as CanonicalEmbeddingsRequest);
      const expected = c.expected as { url: string; headers: Record<string, string>; body: Record<string, unknown>; timeoutMs: number };
      expect(built.url).toBe(expected.url);
      expect(built.headers).toEqual(expected.headers);
      expect(JSON.parse(built.body)).toEqual(expected.body);
      expect(built.timeoutMs).toBe(expected.timeoutMs);
    });
  }
});

describe('openai embeddings client parser (golden)', () => {
  for (const case_ of loadFixtures('embeddings-openai.json')) {
    const c = case_ as FixtureCase;
    if (c.fn !== 'parse') continue;
    it(`parse: ${c.name as string}`, async () => {
      const parsed = await parseOpenAiEmbeddingsRequest(readerOf(c));
      expect(parsed).toEqual(c.expected);
    });
  }
});

describe('gemini embeddings response normalize (golden)', () => {
  for (const case_ of loadFixtures('embeddings-openai.json')) {
    const c = case_ as FixtureCase;
    if (c.fn === 'normalize') {
      it(`normalize: ${c.name as string}`, () => {
        expect(geminiEmbeddingsToOpenAi(c.payload as Record<string, unknown>, c.model as string)).toEqual(c.expected);
      });
    } else if (c.fn === 'normalize-base64') {
      it(`normalize: ${c.name as string}`, () => {
        const out = geminiEmbeddingsToOpenAi(c.payload as Record<string, unknown>, c.model as string, 'base64');
        expect(out.data).toHaveLength(1);
        const embedding = out.data[0].embedding;
        expect(typeof embedding).toBe('string');
        // Decode the base64 back to little-endian float32 and compare values.
        const bin = atob(embedding as string);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const view = new DataView(bytes.buffer);
        const decoded: number[] = [];
        for (let i = 0; i < bytes.length; i += 4) decoded.push(view.getFloat32(i, true));
        const expectedValues = c.expectedValues as number[];
        expect(decoded).toHaveLength(expectedValues.length);
        for (const [i, v] of decoded.entries()) expect(Math.abs(v - expectedValues[i])).toBeLessThan(1e-6);
        // The helper used by the normalizer agrees with the round-trip.
        expect(floatsToBase64(expectedValues)).toBe(embedding as string);
      });
    }
  }
});
