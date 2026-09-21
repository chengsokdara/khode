// Semantic cache (M11) — pure half: the cache key and the request-shape
// eligibility gate. No DB, no Workers-only globals (crypto.subtle is available
// in workers AND Node ≥ 20), so the golden fixtures run offline.
//
// The cache key is a sha-256 over a stable (key-sorted) JSON projection of the
// CANONICAL request + the resolved model slug. Canonical requests are the
// dialect-independent hub, so the same conversation arriving through
// /v1/chat/completions, /v1/messages and /v1/responses hashes to the same key.
// `stream` / `streamIncludeUsage` are deliberately excluded — only
// non-streaming requests are cached, and include_usage is a stream-only hint.
import type { CanonicalChatRequest } from '../canonical';

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays in
 * order, `undefined` object properties skipped (JSON.stringify semantics) and
 * `undefined` array entries collapsing to null. Two requests that differ only
 * in property ORDER therefore share a cache key.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return 'null'; // functions/symbols cannot appear in a canonical request
}

/**
 * The hashed payload: everything about the request that can change the
 * completion. Bumping `v` invalidates every existing entry after a canonical
 * model change (old keys simply stop being looked up and age out via TTL).
 */
export function cacheKeyInput(request: CanonicalChatRequest, modelSlug: string): Record<string, unknown> {
  return {
    v: 1,
    model: modelSlug,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      images: m.images ?? null,
      toolCalls: m.toolCalls ?? null,
      toolCallId: m.toolCallId ?? null,
      extra: m.extra,
    })),
    options: {
      temperature: request.options.temperature ?? null,
      topP: request.options.topP ?? null,
      maxTokens: request.options.maxTokens ?? null,
      maxTokensField: request.options.maxTokensField ?? null,
      stop: request.options.stop ?? null,
      n: request.options.n ?? null,
      tools: request.options.tools ?? null,
      toolChoice: request.options.toolChoice ?? null,
      parallelToolCalls: request.options.parallelToolCalls ?? null,
    },
    extras: request.extras,
    // M17/M18: ride ONLY when present — adding these as unconditional null
    // fields would invalidate every existing entry (the projection is hashed
    // verbatim); spreading keeps pre-M17 keys stable.
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha-256 hex over the stable JSON of the canonical request + model slug. */
export async function buildCacheKey(request: CanonicalChatRequest, modelSlug: string): Promise<string> {
  return sha256Hex(stableStringify(cacheKeyInput(request, modelSlug)));
}

/** Why a request is not cacheable — surfaced in code, not to clients. */
export type CacheIneligibleReason = 'not_opted_in' | 'streaming' | 'tools' | 'tool_history' | 'images' | 'n_gt_1';

/**
 * M11 scope gate: text-only completions only. The master settings switch is
 * checked in the gateway before this; `optedIn` is the per-model OR per-key
 * flag. Everything rejected here either cannot be replayed faithfully
 * (streaming), has side-effect semantics (tools), or is out of the milestone's
 * scope (vision, n>1) — widening later is additive to this gate only.
 */
export function evaluateCacheEligibility(
  request: CanonicalChatRequest,
  opts: { optedIn: boolean },
): { eligible: boolean; reason: CacheIneligibleReason | null } {
  if (!opts.optedIn) return { eligible: false, reason: 'not_opted_in' };
  if (request.stream) return { eligible: false, reason: 'streaming' };
  const tools = request.options.tools;
  if (tools && tools.length > 0) return { eligible: false, reason: 'tools' };
  for (const message of request.messages) {
    if (message.role === 'tool' || (message.toolCalls && message.toolCalls.length > 0)) {
      return { eligible: false, reason: 'tool_history' };
    }
    if (message.images && message.images.length > 0) return { eligible: false, reason: 'images' };
  }
  if ((request.options.n ?? 1) > 1) return { eligible: false, reason: 'n_gt_1' };
  return { eligible: true, reason: null };
}
