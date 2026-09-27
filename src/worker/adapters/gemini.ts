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
// anthropic parser still rejects `thinking`). Assistant-first conversations
// get a spacer user turn prepended; n>1 maps natively onto
// `generationConfig.candidateCount` (the normalizers in dialects/gemini.ts
// fan the candidates back onto openai choices).
//
// Gemini responses are NOT relayed — the upstream speaks its own dialect, so
// every pairing is translated. The gemini→client-dialect translation lives in
// dialects/gemini.ts (normalization onto openai chat shapes, which the
// existing openai→anthropic / openai→responses translators then consume).
import type { Env } from '../env';
import { joinAdapterUrl } from '../env';
import type { CanonicalChatRequest, CanonicalEmbeddingsRequest, CanonicalImage, CanonicalMessage } from '../canonical';
import type { RoutingCandidate } from '../routing';
import { ASSISTANT_FIRST_SPACER, UnsupportedTranslationError, decryptProviderKey, parseHeaderMap, type UpstreamRequest } from './base';
import { EFFORT_BUDGETS } from '../dialects/options';

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
 * M18: maps the canonical responseFormat onto Gemini's schema dialect.
 * `responseSchema` accepts an OpenAPI-3.0 subset — the recursive cleaner
 * below keeps the fields Gemini honors (type/format/description/nullable/
 * enum/properties/required/items/propertyOrdering) and drops the rest
 * (`$schema`, `additionalProperties`, …), lowercasing types onto the
 * OpenAPI vocabulary. `json_object` (no schema) returns null — the MIME
 * type alone is the contract there.
 */
const GEMINI_SCHEMA_KEYS: readonly string[] = [
  'type', 'format', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'items', 'propertyOrdering',
];

function geminiSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(geminiSchemaNode);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (v === undefined) continue;
    if (key === 'type' && typeof v === 'string') {
      out.type = v.toLowerCase();
    } else if (GEMINI_SCHEMA_KEYS.includes(key)) {
      out[key] = key === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, sub]) => [k, geminiSchemaNode(sub)]))
        : key === 'items'
          ? geminiSchemaNode(v)
          : v;
    }
    // every other JSON-Schema keyword is dropped (Gemini would reject or ignore it)
  }
  return out;
}

function geminiResponseSchema(rf: NonNullable<CanonicalChatRequest['responseFormat']>): Record<string, unknown> | null {
  if (rf.type !== 'json_schema' || !rf.schema || typeof rf.schema !== 'object') return null;
  return geminiSchemaNode(rf.schema) as Record<string, unknown>;
}

/**
 * Maps canonical reasoning (M17) — with the openai-dialect `reasoning_effort`
 * / `thinking.budget_tokens` extras as a legacy fallback — onto
 * `generationConfig.thinkingConfig`. `minimal` disables thinking (budget 0 —
 * supported by the Flash tier; Pro rejects it upstream with its own error,
 * surfaced honestly). Numeric budgets are clamped to the documented 0–32768
 * range. When the client opted into reasoning, `includeThoughts: true` asks
 * Gemini for thought summaries so they can be surfaced client-side.
 */
function thinkingConfigFor(req: CanonicalChatRequest): Record<string, unknown> | null {
  const canonical = req.reasoning;
  const extras = req.extras;
  let budget: number | null = null;
  if (canonical?.budgetTokens !== undefined && canonical.budgetTokens !== null) {
    budget = Math.min(32768, Math.max(0, Math.round(canonical.budgetTokens)));
  } else if (canonical?.effort) {
    budget = EFFORT_BUDGETS[canonical.effort];
  } else if (typeof extras['reasoning_effort'] === 'string') {
    const effort = extras['reasoning_effort'];
    budget = effort === 'minimal' ? 0 : effort === 'low' ? 1024 : effort === 'medium' ? 8192 : effort === 'high' ? 24576 : null;
  }
  if (budget === null) {
    const thinking = extras['thinking'];
    if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
      const t = thinking as Record<string, unknown>;
      if (typeof t.budget_tokens === 'number' && Number.isFinite(t.budget_tokens)) {
        budget = Math.min(32768, Math.max(0, Math.round(t.budget_tokens)));
      }
    }
  }
  if (budget === null) return null;
  const config: Record<string, unknown> = { thinkingBudget: budget };
  if (budget > 0) config.includeThoughts = true;
  return config;
}

/**
 * Builds the upstream POST for one candidate. Throws UpstreamMisconfigError
 * when the stored key cannot be decrypted and UnsupportedTranslationError
 * when the canonical request cannot be expressed in the Gemini dialect
 * (system-only). A provider without a key is allowed (proxies/local
 * gateways) — the x-goog-api-key header is omitted.
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
  // n>1 maps natively onto generationConfig.candidateCount (wire fact
  // verified 2026-09-27: "Number of generated responses to return … doesn't
  // work for Gemini 1.0 family"). Candidates carry `index` and
  // usageMetadata totals ACROSS candidates, so usage/billing needs no
  // multiplication. A model that refuses >1 (or a too-high count) rejects
  // upstream — surfaced honestly as a client 4xx.
  const candidateCount = o.n !== undefined && o.n !== null && o.n > 1 ? o.n : null;

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
  // Gemini requires the first content turn to be 'user'. Assistant-first
  // histories (an openai-dialect client providing context or a continuation)
  // get ONE spacer user turn prepended — after the merge, so it can never be
  // merged away or reordered with the functionResponse parts.
  if (merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: ASSISTANT_FIRST_SPACER }] });
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
  const thinkingConfig = thinkingConfigFor(req);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (candidateCount !== null) generationConfig.candidateCount = candidateCount;
  // M18: JSON mode / structured outputs → responseMimeType (+ responseSchema).
  if (req.responseFormat) {
    generationConfig.responseMimeType = 'application/json';
    const responseSchema = geminiResponseSchema(req.responseFormat);
    if (responseSchema) generationConfig.responseSchema = responseSchema;
  }
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
