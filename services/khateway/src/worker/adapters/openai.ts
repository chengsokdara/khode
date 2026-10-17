// OpenAI-compatible upstream adapter. Builds the concrete request against
// `<base_url>/chat/completions` with provider credentials (AES-GCM-decrypted),
// translating the canonical chat request into the Chat Completions dialect
// (M6: images → image_url parts, tool calls → tool_calls/tool messages,
// tools/tool_choice/parallel_tool_calls re-emitted in openai shape). M3
// identity: OpenAI dialect in → OpenAI-compatible upstream out, response
// bodies pass through untouched. Cross-dialect response/SSE translation lives
// in dialects/*; the shared invoke/timeout/credential plumbing in adapters/base.
import type { Env } from '../env';
import { joinAdapterUrl } from '../env';
import type { CanonicalChatRequest, CanonicalContentPart, CanonicalEmbeddingsRequest, CanonicalImage, CanonicalMessage } from '../canonical';
import type { RoutingCandidate } from '../routing';
import { decryptProviderKey, parseHeaderMap, type UpstreamRequest } from './base';

export { UnsupportedTranslationError, invokeUpstream as invokeOpenAi, UpstreamMisconfigError } from './base';
export type { UpstreamOutcome, UpstreamRequest as OpenAiUpstreamRequest } from './base';

/** Image URL part (data URLs are understood natively by openai-compatible upstreams). */
function imageUrlPart(img: CanonicalImage): Record<string, unknown> {
  return { type: 'image_url', image_url: img.detail ? { url: img.url, detail: img.detail } : { url: img.url } };
}

/** One ordered canonical part → one openai content part (source order preserved). */
function openAiContentPart(part: CanonicalContentPart): Record<string, unknown> {
  return part.type === 'text' ? { type: 'text', text: part.text } : imageUrlPart(part.image);
}

/** One canonical message → one openai wire message (string or part-array content). */
function toOpenAiMessage(m: CanonicalMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    if (m.contentParts?.length) {
      return { ...m.extra, role: 'tool', tool_call_id: m.toolCallId, content: m.contentParts.map(openAiContentPart) };
    }
    const images = m.images ?? [];
    const content = images.length
      ? [...(m.content ? [{ type: 'text', text: m.content }] : []), ...images.map(imageUrlPart)]
      : m.content;
    return { ...m.extra, role: 'tool', tool_call_id: m.toolCallId, content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      ...m.extra,
      role: 'assistant',
      content: m.content || null,
      ...(m.reasoning?.text ? { reasoning_content: m.reasoning.text } : {}),
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  // Preserved thinking (GLM, DeepSeek): the original trace has to ride
  // back on the assistant turn. Absent when the message has none, so
  // every other history stays byte-identical.
  const reasoning = m.role === 'assistant' && m.reasoning?.text ? { reasoning_content: m.reasoning.text } : {};
  if (m.contentParts?.length) {
    // Order-preserving emission — the source mixed text and images (or stacked
    // images) and their positions are information.
    return { ...m.extra, ...reasoning, role: m.role, content: m.contentParts.map(openAiContentPart) };
  }
  if (m.images?.length) {
    const parts: Record<string, unknown>[] = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    parts.push(...m.images.map(imageUrlPart));
    return { ...m.extra, ...reasoning, role: m.role, content: parts };
  }
  return { ...m.extra, ...reasoning, role: m.role, content: m.content };
}

/**
 * Builds the upstream POST for one candidate. Throws UpstreamMisconfigError
 * when the stored key cannot be decrypted. A provider without a key is fine
 * (Ollama/vLLM-style local upstreams) — the Authorization header is omitted.
 * Unknown client fields (req.extras) pass through verbatim, per the M3
 * openai-dialect passthrough contract.
 */
export async function buildOpenAiChatRequest(
  env: Env,
  cand: RoutingCandidate,
  req: CanonicalChatRequest,
): Promise<UpstreamRequest> {
  const apiKey = await decryptProviderKey(env, cand); // throws UpstreamMisconfigError

  const headers = { ...parseHeaderMap(cand.provider.defaultHeaders) };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  headers['content-type'] = 'application/json';

  const body: Record<string, unknown> = { ...req.extras };
  body.model = cand.model.upstreamModel;
  body.messages = req.messages.map(toOpenAiMessage);
  body.stream = req.stream;
  // Forward the client's include_usage wish so streaming upstreams send a
  // final usage chunk (relayed untouched on the openai→openai path).
  if (req.streamIncludeUsage !== undefined) body.stream_options = { include_usage: req.streamIncludeUsage };
  // M17: canonical reasoning re-emits as `reasoning_effort` (the openai
  // vocabulary — o-series/GLM-style upstreams accept it; explicit budgets
  // have no openai-side param and stay gateway-only).
  if (req.reasoning?.effort) body.reasoning_effort = req.reasoning.effort;
  // M18: JSON mode / structured outputs re-emitted explicitly (parsed out of
  // extras at parse time — no double-ride).
  if (req.responseFormat) {
    body.response_format =
      req.responseFormat.type === 'json_object'
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: req.responseFormat.name,
              ...(req.responseFormat.strict !== undefined ? { strict: req.responseFormat.strict } : {}),
              schema: req.responseFormat.schema,
            },
          };
  }

  const o = req.options;
  if (o.temperature !== undefined && o.temperature !== null) body.temperature = o.temperature;
  if (o.topP !== undefined && o.topP !== null) body.top_p = o.topP;
  if (o.maxTokens !== undefined && o.maxTokens !== null) body[o.maxTokensField ?? 'max_tokens'] = o.maxTokens;
  if (o.stop !== undefined && o.stop !== null) body.stop = o.stop;
  if (o.n !== undefined && o.n !== null) body.n = o.n;

  if (o.tools?.length) {
    body.tools = o.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.parameters !== undefined && t.parameters !== null ? { parameters: t.parameters } : {}),
      },
    }));
  }
  if (o.toolChoice !== undefined && o.toolChoice !== null) {
    body.tool_choice =
      typeof o.toolChoice === 'string' ? o.toolChoice : { type: 'function', function: { name: o.toolChoice.name } };
  }
  if (o.parallelToolCalls !== undefined && o.parallelToolCalls !== null) {
    body.parallel_tool_calls = o.parallelToolCalls;
  }

  const timeoutMs = Math.min(120_000, Math.max(1_000, cand.provider.timeoutMs ?? 60_000));
  return {
    url: joinAdapterUrl(cand.effectiveBaseUrl('openai'), 'openai', '/chat/completions'),
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  };
}

/**
 * M13: builds the upstream POST for an embeddings request against
 * `<base_url>/embeddings` (the OpenAI embeddings path — openai-compatible
 * proxies expose it on the same /v1 base as /chat/completions). The client's
 * unknown fields (req.extras) pass through verbatim, per the openai-dialect
 * passthrough contract. Responses are relayed untouched — usage for the log
 * row is captured off the relayed body by the gateway's JSON watcher.
 */
export async function buildOpenAiEmbeddingsRequest(
  env: Env,
  cand: RoutingCandidate,
  req: CanonicalEmbeddingsRequest,
): Promise<UpstreamRequest> {
  const apiKey = await decryptProviderKey(env, cand); // throws UpstreamMisconfigError

  const headers = { ...parseHeaderMap(cand.provider.defaultHeaders) };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  headers['content-type'] = 'application/json';

  const body: Record<string, unknown> = { ...req.extras };
  body.model = cand.model.upstreamModel;
  body.input = req.input;
  if (req.dimensions !== undefined && req.dimensions !== null) body.dimensions = req.dimensions;
  if (req.encodingFormat) body.encoding_format = req.encodingFormat;

  const timeoutMs = Math.min(120_000, Math.max(1_000, cand.provider.timeoutMs ?? 60_000));
  return {
    url: joinAdapterUrl(cand.effectiveBaseUrl('openai'), 'openai', '/embeddings'),
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  };
}
