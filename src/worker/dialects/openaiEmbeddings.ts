// OpenAI Embeddings client dialect (/v1/embeddings, M13) — the first non-chat
// client face. This module owns the wire format for it: parsing the incoming
// body into the canonical embeddings request (src/worker/canonical.ts). There
// is no streaming, no tools and no cross-dialect client face here (Anthropic
// has no embeddings API), so the module stays small: the gateway renders every
// error in the OpenAI error envelope (shared with the chat dialect) and
// responses are relayed (openai upstreams) or normalized from native Gemini
// (dialects/gemini.ts).
import type { CanonicalEmbeddingsRequest } from '../canonical';

export type EmbeddingsParse =
  | { ok: true; model: string; request: CanonicalEmbeddingsRequest }
  | { ok: false; status: number; message: string; param?: string | null; code?: string | null };

function parseErr(message: string, param?: string | null, code?: string | null): EmbeddingsParse {
  return { ok: false, status: 400, message, param: param ?? null, code: code ?? null };
}

const KNOWN_FIELDS: readonly string[] = ['model', 'input', 'dimensions', 'encoding_format'];

/**
 * Parses + validates a POST /v1/embeddings body. `input` accepts the openai
 * string / string-array forms (normalized to an array); the pre-tokenized
 * integer-array forms are rejected explicitly — Gemini cannot express them
 * and silently mis-shaping them would break round-trips. Unknown top-level
 * fields are preserved in `extras` for openai-upstream passthrough.
 */
export async function parseOpenAiEmbeddingsRequest(reader: { json: () => Promise<unknown> }): Promise<EmbeddingsParse> {
  let body: unknown;
  try {
    body = await reader.json();
  } catch {
    return parseErr('Request body must be valid JSON', null, 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return parseErr('Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.model !== 'string' || !b.model.trim()) {
    return parseErr("Request must include a 'model' parameter", 'model');
  }

  let input: string[];
  if (typeof b.input === 'string') {
    input = [b.input];
  } else if (Array.isArray(b.input)) {
    if (b.input.every((x) => typeof x === 'string')) {
      input = b.input as string[];
    } else {
      return parseErr(
        'input: pre-tokenized integer input arrays are not supported — send text strings (Khateway routes embeddings across providers)',
        'input',
      );
    }
  } else {
    return parseErr("Request must include an 'input' parameter — a string or an array of strings", 'input');
  }
  if (input.length === 0) {
    return parseErr('input must contain at least one string', 'input');
  }

  let dimensions: number | null = null;
  if (b.dimensions !== undefined && b.dimensions !== null) {
    if (typeof b.dimensions !== 'number' || !Number.isInteger(b.dimensions) || b.dimensions < 1 || b.dimensions > 100000) {
      return parseErr('dimensions must be a positive integer', 'dimensions');
    }
    dimensions = b.dimensions;
  }

  let encodingFormat: 'float' | 'base64' | null = null;
  if (b.encoding_format !== undefined && b.encoding_format !== null) {
    if (b.encoding_format !== 'float' && b.encoding_format !== 'base64') {
      return parseErr("encoding_format must be 'float' or 'base64'", 'encoding_format');
    }
    encodingFormat = b.encoding_format;
  }

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (!KNOWN_FIELDS.includes(k)) extras[k] = v;
  }

  return {
    ok: true,
    model: b.model,
    request: { input, dimensions, encodingFormat, extras },
  };
}
