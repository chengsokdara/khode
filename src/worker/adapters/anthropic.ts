// Anthropic Messages upstream adapter. Builds the concrete request against
// `<base_url>/v1/messages` (the anthropic base_url has NO trailing /v1 —
// DEFAULT_BASES.anthropic is the bare domain; dual-dialect providers may share
// an openai-style `/v1` base URL — joinAdapterUrl strips it) with `x-api-key` +
// `anthropic-version` auth, translating the canonical chat request into the
// Messages dialect: system/developer messages fold into the top-level
// `system` param, turns are merged into strict user/assistant alternation
// (tool_results first inside a user turn; assistant-first histories get a
// spacer user turn prepended — the leading assistant turn stays in place, so
// a lone assistant message reaches the API as prefill), stop → stop_sequences, images →
// image blocks (data URLs split into base64 sources, https URLs passed as
// url sources), tool calls → tool_use/tool_result blocks, and the REQUIRED
// max_tokens defaults to the model's configured max output (4096 when unset).
// Response/SSE translation back into client dialects lives in dialects/*.
import type { Env } from '../env';
import { joinAdapterUrl } from '../env';
import type { CanonicalCacheControl, CanonicalChatRequest, CanonicalImage, CanonicalMessage, CanonicalToolChoice } from '../canonical';
import type { RoutingCandidate } from '../routing';
import { ASSISTANT_FIRST_SPACER, UnsupportedTranslationError, decryptProviderKey, parseHeaderMap, type UpstreamRequest } from './base';
import { EFFORT_BUDGETS, anthropicStructuredOutputTool } from '../dialects/options';

/** Wire value Khateway sends unless the provider overrides it via default_headers. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Client extras that have a home in the Messages dialect; everything else is dropped. */
const ANTHROPIC_EXTRA_KEYS: readonly string[] = ['top_k', 'metadata'];

/** anthropic message content blocks as Khateway builds them. */
type AnthropicBlock = Record<string, unknown>;

/** Splits a `data:<media>;base64,<data>` URL; null for any other shape. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function imageBlock(img: CanonicalImage): AnthropicBlock {
  const data = parseDataUrl(img.url);
  if (data) {
    return { type: 'image', source: { type: 'base64', media_type: data.mediaType, data: data.data } };
  }
  return { type: 'image', source: { type: 'url', url: img.url } };
}

/** Canonical tool_choice → the Messages `tool_choice` param ('none' → tools omitted upstream). */
function anthropicToolChoice(choice: CanonicalToolChoice, parallelDisabled: boolean): AnthropicBlock | null {
  if (choice === 'none') return null;
  if (choice === 'auto') {
    return parallelDisabled ? { type: 'auto', disable_parallel_tool_use: true } : { type: 'auto' };
  }
  if (choice === 'required') {
    return parallelDisabled ? { type: 'any', disable_parallel_tool_use: true } : { type: 'any' };
  }
  return parallelDisabled ? { type: 'tool', name: choice.name, disable_parallel_tool_use: true } : { type: 'tool', name: choice.name };
}

/** One conversation turn: a role plus its content blocks (merged with peers below). */
interface Turn {
  role: 'user' | 'assistant';
  blocks: AnthropicBlock[];
}

/** Folded system text + whether the source block asked for prompt caching (P1). */
interface SystemPart {
  text: string;
  cacheControl?: CanonicalCacheControl;
}

/** Canonical message → turn blocks (or system folds). Tool results become user turns. */
function turnFor(m: CanonicalMessage, system: SystemPart[]): Turn | null {
  if (m.role === 'system' || m.role === 'developer') {
    if (m.content) system.push({ text: m.content, ...(m.cacheControl ? { cacheControl: m.cacheControl } : {}) });
    return null;
  }
  if (m.role === 'tool') {
    const result: AnthropicBlock = { type: 'tool_result', tool_use_id: m.toolCallId };
    // P1: a marked tool_result block is a valid cache breakpoint.
    if (m.cacheControl) result.cache_control = m.cacheControl;
    const images = m.images ?? [];
    if (images.length) {
      const parts: AnthropicBlock[] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      parts.push(...images.map(imageBlock));
      result.content = parts;
    } else if (m.content) {
      result.content = m.content;
    }
    if (m.extra.is_error === true) result.is_error = true;
    return { role: 'user', blocks: [result] };
  }
  const blocks: AnthropicBlock[] = [];
  // M17: thinking/redacted_thinking blocks LEAD an assistant turn (API rule —
  // reasoning precedes content; signatures ride verbatim).
  if (m.reasoning?.redacted) {
    blocks.push({ type: 'redacted_thinking', data: m.reasoning.redacted });
  } else if (m.reasoning?.text) {
    blocks.push({ type: 'thinking', thinking: m.reasoning.text, ...(m.reasoning.signature ? { signature: m.reasoning.signature } : {}) });
  }
  if (m.content) {
    blocks.push({ type: 'text', text: m.content, ...(m.cacheControl ? { cache_control: m.cacheControl } : {}) });
  }
  if (m.role === 'user') {
    for (const img of m.images ?? []) blocks.push(imageBlock(img));
  }
  for (const tc of m.toolCalls ?? []) {
    let input: unknown = {};
    try {
      input = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
    } catch {
      input = {}; // defensive: parsers only admit JSON-encoded arguments
    }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }
  // P1: a marked message with no text (images/tool calls only) still gets its
  // breakpoint — it lands on the turn's last block, which the API allows.
  if (m.cacheControl && !m.content && blocks.length > 0) {
    blocks[blocks.length - 1].cache_control = m.cacheControl;
  }
  if (blocks.length === 0) return null; // empty assistant turns are dropped
  return { role: m.role === 'assistant' ? 'assistant' : 'user', blocks };
}

/**
 * Builds the upstream POST for one candidate. Throws UpstreamMisconfigError
 * when the stored key cannot be decrypted and UnsupportedTranslationError
 * when the canonical request cannot be expressed in the Messages dialect
 * (n > 1, system-only). A provider without a key is allowed
 * (proxies/local gateways) — the x-api-key header is omitted.
 */
export async function buildAnthropicMessagesRequest(
  env: Env,
  cand: RoutingCandidate,
  req: CanonicalChatRequest,
): Promise<UpstreamRequest> {
  const apiKey = await decryptProviderKey(env, cand); // throws UpstreamMisconfigError

  const headers = { ...parseHeaderMap(cand.provider.defaultHeaders) };
  if (apiKey) headers['x-api-key'] = apiKey;
  headers['anthropic-version'] = ANTHROPIC_VERSION;
  headers['content-type'] = 'application/json';

  const system: SystemPart[] = [];
  const turns: Turn[] = [];
  for (const m of req.messages) {
    const turn = turnFor(m, system);
    if (turn) turns.push(turn);
  }
  // The Messages API requires strict alternation starting with `user`; merge
  // consecutive same-role turns instead of failing. tool_result blocks must
  // lead a user turn (API rule), so user merges are reordered accordingly.
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.blocks.push(...t.blocks);
    else merged.push({ ...t, blocks: [...t.blocks] });
  }
  for (const turn of merged) {
    if (turn.role === 'user') {
      const results = turn.blocks.filter((b) => b.type === 'tool_result');
      const rest = turn.blocks.filter((b) => b.type !== 'tool_result');
      turn.blocks = [...results, ...rest];
    }
  }
  if (merged.length === 0) {
    throw new UnsupportedTranslationError(
      'Anthropic upstreams require at least one user or assistant message — only system messages were provided.',
    );
  }
  // The API requires the first message to use the 'user' role. Assistant-first
  // histories (an openai-dialect client providing context or a continuation)
  // get ONE spacer user turn prepended; the leading assistant turn stays where
  // it is, so a lone assistant message still lands last = the API's documented
  // prefill rule (the response continues from the final assistant message).
  if (merged[0].role !== 'user') {
    merged.unshift({ role: 'user', blocks: [{ type: 'text', text: ASSISTANT_FIRST_SPACER }] });
  }

  const o = req.options;
  if (o.n !== undefined && o.n !== null && o.n > 1) {
    throw new UnsupportedTranslationError(
      `The Anthropic Messages dialect has no multi-choice equivalent for n=${o.n} — only n=1 can be translated.`,
    );
  }

  const maxTokens =
    o.maxTokens !== undefined && o.maxTokens !== null ? o.maxTokens : (cand.model.maxOutputTokens ?? 4096);

  // M17: canonical reasoning → the Messages `thinking` param. Explicit budgets
  // win over the effort buckets; the budget is clamped below max_tokens (API
  // rule) and disabled when there is no room left. With thinking enabled the
  // API forbids top_p/top_k tweaks and temperatures above 1 — they're dropped
  // rather than guaranteed-400ing the request.
  const budgetRequested =
    req.reasoning?.budgetTokens != null
      ? Math.round(req.reasoning.budgetTokens)
      : req.reasoning?.effort
        ? (EFFORT_BUDGETS[req.reasoning.effort] || 1024)
        : null;
  let thinkingBudget: number | null = null;
  if (budgetRequested !== null && budgetRequested > 0) {
    const clamped = Math.min(budgetRequested, maxTokens - 1);
    thinkingBudget = clamped >= 1024 ? clamped : null;
  }

  const body: Record<string, unknown> = {};
  for (const key of ANTHROPIC_EXTRA_KEYS) {
    if (key in req.extras) body[key] = req.extras[key];
  }
  // NOTE: remaining client extras are openai-dialect fields (frequency_penalty,
  // seed, …) that the Messages API would reject — dropped deliberately.
  // M18: the Messages dialect has no native JSON mode. When structured-output
  // emulation applies (no client tools, no thinking), the request becomes a
  // FORCED SINGLE TOOL — under tool_choice {type:'tool'} the API guarantees a
  // tool_use block, the same hard guarantee openai's json_schema gives — and
  // the anthropic-upstream translators unwrap its input back into client
  // content. Everything else falls back to the best-effort system directive
  // (documented: not a hard guarantee).
  const structuredTool = anthropicStructuredOutputTool(req);
  if (req.responseFormat && !structuredTool) {
    const directive =
      req.responseFormat.type === 'json_schema'
        ? `Respond with ONLY a JSON object (no prose, no code fences) conforming exactly to this JSON schema:\n${JSON.stringify(req.responseFormat.schema)}`
        : 'Respond with ONLY a valid JSON object (no prose, no code fences).';
    system.push({ text: directive });
  }
  // P1: a marked system message switches the param to a block array so the
  // cache breakpoint survives the fold (last marked system message wins).
  if (system.length > 0) {
    const joined = system.map((s) => s.text).join('\n\n');
    const marker = system.slice().reverse().find((s) => s.cacheControl)?.cacheControl;
    body.system = marker ? [{ type: 'text', text: joined, cache_control: marker }] : joined;
  }
  body.messages = merged.map((t) => ({ role: t.role, content: t.blocks }));
  body.model = cand.model.upstreamModel;
  body.max_tokens = maxTokens;
  body.stream = req.stream;
  if (thinkingBudget !== null) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  } else {
    if (o.temperature !== undefined && o.temperature !== null) body.temperature = o.temperature;
    if (o.topP !== undefined && o.topP !== null) body.top_p = o.topP;
  }
  if (o.stop !== undefined && o.stop !== null && o.stop.length > 0) body.stop_sequences = o.stop;

  if (structuredTool) {
    // M18 structured-output emulation: one synthetic tool, forced choice —
    // the response's tool_use input is the JSON answer (unwrapped client-side).
    body.tools = [
      {
        name: structuredTool.name,
        description: structuredTool.description,
        input_schema: structuredTool.inputSchema,
      },
    ];
    body.tool_choice = { type: 'tool', name: structuredTool.name };
  } else if (o.tools?.length) {
    // tool_choice 'none' means "offer nothing" — the Messages dialect has no
    // none choice, so the tools are omitted from the request entirely.
    if (o.toolChoice !== 'none') {
      body.tools = o.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.parameters ?? { type: 'object' },
        ...(t.cacheControl ? { cache_control: t.cacheControl } : {}),
      }));
      const parallelDisabled = o.parallelToolCalls === false;
      const choice = anthropicToolChoice(o.toolChoice ?? 'auto', parallelDisabled);
      if (choice) body.tool_choice = choice;
    }
  }

  const timeoutMs = Math.min(120_000, Math.max(1_000, cand.provider.timeoutMs ?? 60_000));
  return {
    // joinAdapterUrl strips a trailing `/v1` from shared dual-dialect base
    // URLs so one provider base URL serves both conventions.
    url: joinAdapterUrl(cand.effectiveBaseUrl('anthropic'), 'anthropic', '/v1/messages'),
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  };
}
