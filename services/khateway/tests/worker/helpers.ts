// Shared harness for the golden-fixture suite. Fixtures live in
// tests/fixtures/*.json as arrays of cases; the helpers load them, drive the
// wire-format functions (fake request readers, SSE byte streams) and normalize
// wall-clock values so golden expectations stay byte-stable across runs.
import { readFileSync } from 'node:fs';

/** One fixture case: a name plus free-form fields interpreted by the runner. */
export type FixtureCase = Record<string, unknown>;

/** Loads an array of fixture cases from tests/fixtures/<rel>. */
export function loadFixtures(rel: string): FixtureCase[] {
  const path = new URL(`../fixtures/${rel}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureCase[];
}

/** A case.body → reader shaped like a Request (or a rejecting one for invalid JSON). */
export function readerOf(case_: FixtureCase): { json: () => Promise<unknown> } {
  if (case_.invalidJson === true) {
    return { json: () => Promise.reject(new SyntaxError('Unexpected token in JSON')) };
  }
  const body = case_.body;
  return { json: () => Promise.resolve(body) };
}

/** Serializes fixture events (`{event?, data}`) into wire-format SSE text. */
export function sseText(events: { event?: string; data: unknown }[]): string {
  return events
    .map((ev) => `${ev.event ? `event: ${ev.event}\n` : ''}data: ${JSON.stringify(ev.data)}\n\n`)
    .join('');
}

/** A byte stream delivering `text` (optionally split into explicit chunks). */
export function sseSource(text: string, chunks?: string[]): ReadableStream<Uint8Array> {
  const parts = chunks ?? [text];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** Drains a translated stream into text. */
export async function streamText(src: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(src).text();
}

export interface ParsedSse {
  /** `event:` field, '' when absent (openai chunk streams never name events). */
  event: string;
  /** Parsed JSON payload; the literal string for sentinels like `[DONE]`. */
  data: unknown;
}

/** Parses translated SSE output back into structured events for comparison. */
export function parseSse(text: string): ParsedSse[] {
  const out: ParsedSse[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    let parsed: unknown = data;
    if (data !== '[DONE]') {
      try {
        parsed = JSON.parse(data);
      } catch {
        // keep raw text
      }
    }
    out.push({ event, data: parsed });
  }
  return out;
}

/**
 * Replaces wall-clock values (`created` / `created_at` epoch seconds) with a
 * stable sentinel so golden expectations don't churn between runs. Fixture
 * expectations use "<now>" wherever a timestamp is emitted.
 */
export function freezeTimestamps(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(freezeTimestamps);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        (k === 'created' || k === 'created_at') && typeof val === 'number' ? '<now>' : freezeTimestamps(val);
    }
    return out;
  }
  return v;
}

// ------------------------------------------------------------- adapter utils

/**
 * Fixed 32-byte test ENCRYPTION_KEY (base64) — only used inside this suite to
 * encrypt throwaway fixture keys at runtime (ciphertexts embed a random IV, so
 * they cannot be pre-baked into fixture files).
 */
export const TEST_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

export interface CandidateOverrides {
  model?: Partial<{
    id: string;
    slug: string;
    upstreamModel: string;
    maxOutputTokens: number | null;
  }>;
  provider?: Partial<{
    name: string;
    adapters: import('../../src/worker/env').Adapter[];
    baseUrl: string | null;
    apiKeyEnc: string | null;
    defaultHeaders: string | null;
    timeoutMs: number | null;
  }>;
  baseUrl?: string;
}

/** Builds a full RoutingCandidate with neutral defaults + case overrides. */
export function makeCandidate(
  overrides: CandidateOverrides,
  apiKeyEnc: string | null = null,
): import('../../src/worker/routing').RoutingCandidate {
  const model = {
    id: 'mdl_test',
    slug: 'test-model',
    upstreamModel: 'test-model',
    baseUrlOverride: null,
    apiKeyOverrideEnc: null,
    maxOutputTokens: null,
    pricingInput: null,
    pricingOutput: null,
    fallbacks: [],
    rateLimitRpm: null,
    cacheEnabled: false,
    enabled: true,
    ...overrides.model,
  };
  const provider: import('../../src/worker/routing').RoutingCandidate['provider'] = {
    id: 'prv_test',
    name: 'Test Provider',
    adapters: ['openai'],
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc,
    defaultHeaders: null,
    timeoutMs: null,
    enabled: true,
    ...overrides.provider,
  };
  const baseUrl = overrides.baseUrl ?? provider.baseUrl ?? 'https://api.example.com/v1';
  return {
    model,
    provider,
    baseUrl,
    effectiveBaseUrl: () => baseUrl,
  };
}
