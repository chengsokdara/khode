// Native Gemini generateContent upstream adapter (M12). Builds the concrete
// request against `{base_url}/models/{model}:generateContent` (streaming:
// `:streamGenerateContent?alt=sse` — the endpoint choice encodes streaming,
// the body has no `stream` field) with `x-goog-api-key` auth, translating the
// canonical chat request into the Gemini dialect: system/developer messages
// fold into the top-level `systemInstruction`, roles map user→user /
// assistant→model, tool results become `functionResponse` parts (bound by
// tool NAME — Gemini has no call ids, so the name is resolved from the
// assistant turn's `functionCall`), tool calls → `functionCall` parts with
// object arguments, images → `inlineData` (data URLs) / `fileData` (https),
// and `reasoning_effort` extras map onto `generationConfig.thinkingConfig.
// thinkingBudget` (thinking arrives only via the openai-face extra — the
// anthropic parser still rejects `thinking`). n>1 and assistant-first
// conversations are rejected 400 `untranslatable_request` (explicit, matching
// the anthropic adapter stance; dual-adapter providers retry elsewhere).
//
// Gemini responses are NOT relayed — the upstream speaks its own dialect, so
// every pairing is translated. The gemini→client-dialect translation lives in
// dialects/gemini.ts (normalization onto openai chat shapes, which the
// existing openai→anthropic / openai→responses translators then consume).
import type { Env } from '../env';
import { joinAdapterUrl } from '../env';
import type { CanonicalChatRequest, CanonicalEmbeddingsRequest, CanonicalImage, CanonicalMessage } from '../canonical';
import type { RoutingCandidate } from '../routing';
import { UnsupportedTranslationError, decryptProviderKey, parseHeaderMap, type UpstreamRequest } from './base';

/** Splits a `data:<media>;base64,<data>` URL; null for any other shape. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** Canonical image → a Gemini part: data URLs inline, https via fileData. */
function imagePart(img: CanonicalImage): Record<string, unknown> {
  const data = parseDataUrl(img.url);
  if (data) return { inlineData: { mimeType: data.mediaType, data: data.data } };
  return { fileData: { mimeType: 'image/png', fileUri: img.url } };
}

/** Canonical role → the Gemini roles ('user' | 'model'). */
function geminiRole(role: CanonicalMessage['role']): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

/** One canonical message → Gemini parts (or null for dropped/empty turns). */
function partsFor(m: CanonicalMessage, functionNameById: Map<string, string>): Record<string, unknown>[] | null {
  if (m.role === 'system' || m.role === 'developer') return null; // folded into systemInstruction
  if (m.role === 'tool') {
    // Tool results: the content rides INSIDE the functionResponse object (no
    // separate text part — it would duplicate); images attach as extra parts.
    // Gemini binds tool results by NAME, not id — resolve it from the
    // assistant turn that declared the call (fallback: the raw id).
    const name = (m.toolCallId ? functionNameById.get(m.toolCallId) : undefined) ?? m.toolCallId ?? '';
    let response: Record<string, unknown>;
    if (m.content.trim().startsWith('{') || m.content.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(m.content);
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: m.content };
      } catch {
        response = { result: m.content };
      }
    } else {
      response = { result: m.content };
    }
    const parts: Record<string, unknown>[] = [{ functionResponse: { name, response } }];
    for (const img of m.images ?? []) parts.push(imagePart(img));
    return parts;
  }
  const parts: Record<string, unknown>[] = [];
  if (m.content) parts.push({ text: m.content });
  for (const tc of m.toolCalls ?? []) {
    let args: unknown = {};
    try {
      args = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
    } catch {
      args = {}; // defensive: parsers only admit JSON-encoded arguments
    }
    parts.push({ functionCall: { name: tc.name, args } });
  }
  for (const img of m.images ?? []) parts.push(imagePart(img));
  return parts.length ? parts : null;
}

/**
 * Maps the openai-dialect `reasoning_effort` extra (and a defensive
 * `thinking.budget_tokens` extra) onto `generationConfig.thinkingConfig`.
 * `minimal` disables thinking (budget 0 — supported by the Flash tier; Pro
 * rejects it upstream with its own error, surfaced honestly). Numeric
 * budgets are clamped to the documented 0–32768 range.
 */
function thinkingConfigFor(extras: Record<string, unknown>): Record<string, unknown> | null {
  const effort = extras['reasoning_effort'];
  if (typeof effort === 'string') {
    const budget = effort === 'minimal' ? 0 : effort === 'low' ? 1024 : effort === 'medium' ? 8192 : effort === 'high' ? 24576 : null;
    if (budget !== null) return { thinkingBudget: budget };
  }
  const thinking = extras['thinking'];
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const t = thinking as Record<string, unknown>;
    if (typeof t.budget_tokens === 'number' && Number.isFinite(t.budget_tokens)) {
      return { thinkingBudget: Math.min(32768, Math.max(0, Math.round(t.budget_tokens))) };
    }
  }
  return null;
}

/**
 * Builds the upstream POST for one candidate. Throws UpstreamMisconfigError
 * when the stored key cannot be decrypted and UnsupportedTranslationError
 * when the canonical request cannot be expressed in the Gemini dialect
 * (assistant-first conversations, n > 1, system-only). A provider without a
 * key is allowed (proxies/local gateways) — the x-goog-api-key header is
 * omitted.
 */
export async function buildGeminiGenerateContentRequest(
  env: Env,
  cand: RoutingCandidate,
  req: CanonicalChatRequest,
): Promise<UpstreamRequest> {
  const apiKey = await decryptProviderKey(env, cand); // throws UpstreamMisconfigError

  const headers = { ...parseHeaderMap(cand.provider.defaultHeaders) };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  headers['content-type'] = 'application/json';

  const o = req.options;
  if (o.n !== undefined && o.n !== null && o.n > 1) {
    throw new UnsupportedTranslationError(
      `The Gemini generateContent dialect has no multi-choice equivalent for n=${o.n} — only n=1 can be translated.`,
    );
  }

  // Tool-name lookup for functionResponse binding (Gemini binds by name).
  const functionNameById = new Map<string, string>();
  for (const m of req.messages) {
    for (const tc of m.toolCalls ?? []) functionNameById.set(tc.id, tc.name);
  }

  const system: string[] = [];
  interface GeminiTurn {
    role: 'user' | 'model';
    parts: Record<string, unknown>[];
  }
  const turns: GeminiTurn[] = [];
  for (const m of req.messages) {
    const parts = partsFor(m, functionNameById);
    if (m.role === 'system' || m.role === 'developer') {
      if (m.content) system.push(m.content);
      continue;
    }
    if (!parts) continue; // empty turns are dropped
    turns.push({ role: geminiRole(m.role), parts });
  }
  // Merge consecutive same-role turns; functionResponse parts lead user turns
  // (mirrors the anthropic tool_result-first rule).
  const merged: GeminiTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.parts.push(...t.parts);
    else merged.push({ ...t, parts: [...t.parts] });
  }
  for (const turn of merged) {
    if (turn.role === 'user') {
      const responses = turn.parts.filter((p) => 'functionResponse' in p);
      const rest = turn.parts.filter((p) => !('functionResponse' in p));
      turn.parts = [...responses, ...rest];
    }
  }
  if (merged.length === 0) {
    throw new UnsupportedTranslationError(
      'Gemini upstreams require at least one user or model message — only system messages were provided.',
    );
  }
  if (merged[0].role !== 'user') {
    throw new UnsupportedTranslationError(
      "Gemini upstreams require the first message to use the 'user' role; this conversation starts with 'model'.",
    );
  }

  const body: Record<string, unknown> = {};
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  body.contents = merged.map((t) => ({ role: t.role, parts: t.parts }));

  const generationConfig: Record<string, unknown> = {};
  if (o.temperature !== undefined && o.temperature !== null) generationConfig.temperature = o.temperature;
  if (o.topP !== undefined && o.topP !== null) generationConfig.topP = o.topP;
  if (o.maxTokens !== undefined && o.maxTokens !== null) generationConfig.maxOutputTokens = o.maxTokens;
  if (o.stop !== undefined && o.stop !== null && o.stop.length > 0) generationConfig.stopSequences = o.stop;
  if (typeof req.extras.top_k === 'number' && Number.isFinite(req.extras.top_k)) {
    generationConfig.topK = req.extras.top_k;
  }
  const thinkingConfig = thinkingConfigFor(req.extras);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  // NOTE: remaining client extras are openai/anthropic-dialect fields Gemini
  // would reject — dropped deliberately (same stance as the anthropic adapter).

  if (o.tools?.length) {
    body.tools = [
      {
        functionDeclarations: o.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.parameters !== undefined && t.parameters !== null ? { parameters: t.parameters } : {}),
        })),
      },
    ];
    if (o.toolChoice !== undefined && o.toolChoice !== null) {
      const config: Record<string, unknown> =
        o.toolChoice === 'none'
          ? { mode: 'NONE' }
          : o.toolChoice === 'required'
            ? { mode: 'ANY' }
            : o.toolChoice === 'auto'
              ? { mode: 'AUTO' }
              : { mode: 'ANY', allowedFunctionNames: [o.toolChoice.name] };
      body.toolConfig = { functionCallingConfig: config };
    }
  }

  const timeoutMs = Math.min(120_000, Math.max(1_000, cand.provider.timeoutMs ?? 60_000));
  const action = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return {
    url: joinAdapterUrl(
      cand.effectiveBaseUrl('gemini'),
      'gemini',
      `/models/${encodeURIComponent(cand.model.upstreamModel)}:${action}`,
    ),
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  };
}

/**
 * M13: builds the upstream POST for an embeddings request — single text →
 * `POST {base}/models/{model}:embedContent`, several texts →
 * `:batchEmbedContents` (one request entry per input, embeddings come back in
 * input order). Per the Google embedContent schema the body carries
 * `model: "models/{id}"` + `content:{parts:[{text}]}`; openai `dimensions`
 * maps onto `embedContentConfig.outputDimensionality` and the openai-style
 * `task_type` / `title` extras onto `taskType` / `title` (other extras are
 * openai-dialect fields Gemini would reject — dropped, same stance as chat).
 * Wire format verified 2026-09-19 against ai.google.dev/api/embeddings.
 */
export async function buildGeminiEmbeddingsRequest(
  env: Env,
  cand: RoutingCandidate,
  req: CanonicalEmbeddingsRequest,
): Promise<UpstreamRequest> {
  const apiKey = await decryptProviderKey(env, cand); // throws UpstreamMisconfigError

  const headers = { ...parseHeaderMap(cand.provider.defaultHeaders) };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  headers['content-type'] = 'application/json';

  const config: Record<string, unknown> = {};
  if (req.dimensions !== undefined && req.dimensions !== null) config.outputDimensionality = req.dimensions;
  if (typeof req.extras.task_type === 'string') config.taskType = req.extras.task_type;
  if (typeof req.extras.title === 'string') config.title = req.extras.title;
  const hasConfig = Object.keys(config).length > 0;

  const entry = (text: string): Record<string, unknown> => ({
    model: `models/${cand.model.upstreamModel}`,
    content: { parts: [{ text }] },
    ...(hasConfig ? { embedContentConfig: config } : {}),
  });

  const single = req.input.length === 1;
  const body: Record<string, unknown> = single ? entry(req.input[0]) : { requests: req.input.map(entry) };
  const action = single ? 'embedContent' : 'batchEmbedContents';

  const timeoutMs = Math.min(120_000, Math.max(1_000, cand.provider.timeoutMs ?? 60_000));
  return {
    url: joinAdapterUrl(
      cand.effectiveBaseUrl('gemini'),
      'gemini',
      `/models/${encodeURIComponent(cand.model.upstreamModel)}:${action}`,
    ),
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  };
}
