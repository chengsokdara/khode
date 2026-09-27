// Shared request-option validators for the dialect parsers (dialects/*).
// Extracted from openaiChat.ts in M4 so the anthropic parser enforces the
// same bounds; each dialect decides which of these to apply and with which
// limits (e.g. openai `stop` ≤ 4 strings, anthropic `stop_sequences` ≤ 16).
// M6 adds the shared tool-definition / tool_choice / image validators used by
// all three dialect parsers — they normalize each dialect's wire shape onto
// the canonical form (src/worker/canonical.ts).

import type { CanonicalCacheControl, CanonicalChatRequest, CanonicalImage, CanonicalReasoning, CanonicalReasoningContent, CanonicalToolChoice, CanonicalToolDef } from '../canonical';

export type OptResult = { err?: string; val?: number | null };

// -------------------------------------------------------------- M17 reasoning

/** Effort → token budget. Gemini: minimal disables thinking (budget 0). */
export const EFFORT_BUDGETS: Record<NonNullable<CanonicalReasoning['effort']>, number> = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
};

/** Validates the openai/responses `reasoning_effort` vocabulary. */
export function reasoningEffortOption(v: unknown, param: string): { err?: string; val?: CanonicalReasoning['effort'] } {
  if (v === undefined || v === null) return {};
  if (v === 'minimal' || v === 'low' || v === 'medium' || v === 'high') return { val: v };
  return { err: `${param} must be one of 'minimal', 'low', 'medium', 'high'` };
}

/** Merges an effort bucket + explicit budget into one canonical reasoning value. */
export function canonicalReasoning(effort?: CanonicalReasoning['effort'], budgetTokens?: number | null): CanonicalReasoning | null {
  if (budgetTokens != null && Number.isFinite(budgetTokens)) {
    return { ...(effort ? { effort } : {}), budgetTokens: Math.max(0, Math.round(budgetTokens)) };
  }
  return effort ? { effort } : null;
}

/** Normalizes thinking/reasoning content pieces onto the canonical shape. */
export function canonicalReasoningContent(parts: { text?: string; signature?: string; redacted?: string }): CanonicalReasoningContent | undefined {
  const out: CanonicalReasoningContent = {};
  if (parts.text) out.text = parts.text;
  if (parts.signature) out.signature = parts.signature;
  if (parts.redacted) out.redacted = parts.redacted;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ------------------------------------------------------ M18 response format

/**
 * Validates + normalizes a JSON-mode / structured-output param onto the
 * canonical shape. Two dialect shapes arrive here:
 * - openai chat `response_format`: `{type:'json_object'}` or
 *   `{type:'json_schema', json_schema:{name, strict?, schema}}`
 * - responses `text.format`: `{type:'json_object'}` or
 *   `{type:'json_schema', name, schema, strict?}` (flat)
 * `shape` picks the reader. Anything else → explicit error.
 */
export function responseFormatOption(
  v: unknown,
  param: string,
  shape: 'openai-chat' | 'responses',
): { err?: string; val?: import('../canonical').CanonicalResponseFormat } {
  if (v === undefined || v === null) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { err: `${param} must be an object` };
  const raw = v as Record<string, unknown>;
  if (raw.type === 'json_object') return { val: { type: 'json_object' } };
  if (raw.type === 'text') return {}; // responses dialect: plain text (default)
  if (raw.type === 'json_schema') {
    if (shape === 'openai-chat') {
      const inner = raw.json_schema;
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        return { err: `${param}.json_schema must be an object` };
      }
      const j = inner as Record<string, unknown>;
      if (typeof j.name !== 'string' || !j.name) return { err: `${param}.json_schema.name must be a string` };
      if (j.schema === undefined || j.schema === null || typeof j.schema !== 'object') {
        return { err: `${param}.json_schema.schema must be an object` };
      }
      return {
        val: {
          type: 'json_schema',
          name: j.name,
          schema: j.schema,
          ...(j.strict === true ? { strict: true } : {}),
        },
      };
    }
    if (typeof raw.name !== 'string' || !raw.name) return { err: `${param}.name must be a string` };
    if (raw.schema === undefined || raw.schema === null || typeof raw.schema !== 'object') {
      return { err: `${param}.schema must be an object` };
    }
    return {
      val: {
        type: 'json_schema',
        name: raw.name,
        schema: raw.schema,
        ...(raw.strict === true ? { strict: true } : {}),
      },
    };
  }
  return { err: `${param}.type must be 'json_object', 'json_schema'${shape === 'responses' ? " or 'text'" : ''}` };
}

// ---------------------------------------- M18+ anthropic structured-output emulation

/** The fixed fallback name for the synthetic structured-output tool. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'structured_output';

const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  'Emit the response as a single JSON object conforming to the input schema. No prose, no code fences.';

/** The synthetic tool a responseFormat request becomes on the anthropic wire. */
export interface AnthropicStructuredTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Structured outputs on ANTHROPIC upstreams ride a forced single tool — under
 * `tool_choice: {type:'tool'}` the Messages API prefills the assistant turn,
 * guaranteeing a tool_use block, which is the same hard guarantee openai's
 * json_schema gives. The synthetic tool never reaches the client: the
 * anthropic-upstream translators unwrap its input back into message content
 * (dialects/openaiChat.ts + openaiResponses.ts, keyed on the meta flag this
 * helper's non-null result stamps). Returns null (→ the best-effort system
 * directive stays) when emulation cannot apply:
 * - the request carries no responseFormat;
 * - the client declared its own tools (forcing the synthetic tool would break
 *   the client's tool loop);
 * - reasoning/thinking is requested — the Messages API rejects forced
 *   tool_choice while extended thinking is enabled (conservative even when
 *   the adapter's clamp would drop the budget — this helper cannot see
 *   max_tokens).
 * The tool is injected ONLY at adapter level; the canonical request (and thus
 * the M11 cache key) never carries it.
 */
export function anthropicStructuredOutputTool(
  req: Pick<CanonicalChatRequest, 'responseFormat' | 'reasoning' | 'options'>,
): AnthropicStructuredTool | null {
  if (!req.responseFormat) return null;
  if (req.options.tools && req.options.tools.length > 0) return null;
  if (req.reasoning) return null;
  return {
    name: structuredOutputToolName(req.responseFormat.name),
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    inputSchema:
      req.responseFormat.type === 'json_schema' && req.responseFormat.schema
        ? req.responseFormat.schema
        : { type: 'object' },
  };
}

/** Sanitizes the declared schema name onto the Messages tool-name alphabet (`[a-zA-Z0-9_-]{1,64}`). */
function structuredOutputToolName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
  return cleaned || STRUCTURED_OUTPUT_TOOL_NAME;
}

export function floatOption(v: unknown, param: string, lo: number, hi: number): OptResult {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
    return { err: `${param} must be a number between ${lo} and ${hi}` };
  }
  return { val: v };
}

export function intOption(v: unknown, param: string, lo: number, hi: number): OptResult {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    return { err: `${param} must be an integer between ${lo} and ${hi}` };
  }
  return { val: v };
}

export function stopOption(v: unknown, maxCount = 4): { err?: string; val?: string[] | null } {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  const items = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  const okItems = !!items && items.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128);
  if (!okItems || items.length > maxCount) {
    return { err: `stop must be a string or an array of at most ${maxCount} strings (≤128 chars each)` };
  }
  return { val: items as string[] };
}

export function boolOption(v: unknown, param: string): { err?: string; val?: boolean | null } {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  if (typeof v !== 'boolean') return { err: `${param} must be a boolean` };
  return { val: v };
}

// ------------------------------------------------------------------- tools

/**
 * P1: anthropic `cache_control` block marker → canonical. Accepts
 * `{type:'ephemeral'}` with an optional `ttl` ('5m' default | '1h'); unknown
 * ttl values are rejected so a typo never silently loses caching. Absent/null
 * → undefined (no marker).
 */
export function cacheControlOption(v: unknown, param: string): { err?: string; val?: CanonicalCacheControl } {
  if (v === undefined || v === null) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { err: `${param} must be an object like {type: "ephemeral"}` };
  const c = v as Record<string, unknown>;
  if (c.type !== 'ephemeral') return { err: `${param}.type must be 'ephemeral'` };
  if (c.ttl === undefined || c.ttl === null) return { val: { type: 'ephemeral' } };
  if (c.ttl !== '5m' && c.ttl !== '1h') return { err: `${param}.ttl must be '5m' or '1h'` };
  return { val: { type: 'ephemeral', ttl: c.ttl } };
}

/**
 * Client-declared tools → canonical defs, per source dialect:
 * - `openai`: `[{type:'function', function:{name, description?, parameters?}}]`
 * - `anthropic`: `[{name, description?, input_schema}]`
 * - `responses`: `[{type:'function', name, description?, parameters?}]` (flat)
 * Non-function / server-hosted tool types are rejected — Khateway only routes
 * client-executed function tools (hosted tools execute inside one vendor's
 * cloud and cannot be translated to another dialect).
 */
export function toolDefsOption(
  v: unknown,
  mode: 'openai' | 'anthropic' | 'responses',
): { err?: string; val?: CanonicalToolDef[] | null } {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  if (!Array.isArray(v)) return { err: 'tools must be an array of tool definitions' };
  const defs: CanonicalToolDef[] = [];
  for (const [i, raw] of v.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: `tools[${i}] must be an object` };
    }
    const t = raw as Record<string, unknown>;
    if (mode === 'anthropic') {
      if (typeof t.type === 'string') {
        return { err: `tools[${i}]: server-hosted tool type '${t.type}' cannot be routed across dialects — only client-executed tools are supported` };
      }
      if (typeof t.name !== 'string' || !t.name) return { err: `tools[${i}].name must be a string` };
      if (t.description !== undefined && t.description !== null && typeof t.description !== 'string') {
        return { err: `tools[${i}].description must be a string` };
      }
      if (!t.input_schema || typeof t.input_schema !== 'object' || Array.isArray(t.input_schema)) {
        return { err: `tools[${i}].input_schema must be a JSON schema object` };
      }
      // P1: anthropic tool defs can carry a prompt-cache marker.
      const cc = cacheControlOption(t.cache_control, `tools[${i}].cache_control`);
      if (cc.err) return { err: cc.err };
      defs.push({
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        parameters: t.input_schema,
        ...(cc.val ? { cacheControl: cc.val } : {}),
      });
      continue;
    }
    // openai + responses declare function tools with type:'function'
    if (t.type !== 'function') {
      return { err: `tools[${i}]: tool type '${String(t.type)}' is vendor-hosted and cannot be routed across dialects — only 'function' tools are supported` };
    }
    if (mode === 'responses') {
      if (typeof t.name !== 'string' || !t.name) return { err: `tools[${i}].name must be a string` };
      if (t.description !== undefined && t.description !== null && typeof t.description !== 'string') {
        return { err: `tools[${i}].description must be a string` };
      }
      if (t.parameters !== undefined && t.parameters !== null && (typeof t.parameters !== 'object' || Array.isArray(t.parameters))) {
        return { err: `tools[${i}].parameters must be a JSON schema object` };
      }
      defs.push({
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(t.parameters !== undefined && t.parameters !== null ? { parameters: t.parameters } : {}),
      });
      continue;
    }
    const fn = t.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return { err: `tools[${i}].function must be an object` };
    const f = fn as Record<string, unknown>;
    if (typeof f.name !== 'string' || !f.name) return { err: `tools[${i}].function.name must be a string` };
    if (f.description !== undefined && f.description !== null && typeof f.description !== 'string') {
      return { err: `tools[${i}].function.description must be a string` };
    }
    if (f.parameters !== undefined && f.parameters !== null && (typeof f.parameters !== 'object' || Array.isArray(f.parameters))) {
      return { err: `tools[${i}].function.parameters must be a JSON schema object` };
    }
    defs.push({
      name: f.name,
      ...(typeof f.description === 'string' ? { description: f.description } : {}),
      ...(f.parameters !== undefined && f.parameters !== null ? { parameters: f.parameters } : {}),
    });
  }
  return { val: defs };
}

/** Tool-choice → canonical, per source dialect. */
export function toolChoiceOption(
  v: unknown,
  mode: 'openai' | 'anthropic' | 'responses',
): { err?: string; val?: CanonicalToolChoice | null } {
  if (v === undefined) return { val: undefined };
  if (v === null) return { val: null };
  if (typeof v === 'string') {
    if (mode === 'anthropic') return { err: 'tool_choice must be an object like {type: "auto" | "any" | "tool" | "none", name?}' };
    if (v === 'auto' || v === 'none' || v === 'required') return { val: v };
    return { err: `tool_choice must be 'auto', 'none', 'required' or a function specifier` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { err: 'tool_choice must be a string or an object' };
  const t = v as Record<string, unknown>;
  if (mode === 'anthropic') {
    if (t.type === 'auto') return { val: 'auto' };
    if (t.type === 'any') return { val: 'required' };
    if (t.type === 'none') return { val: 'none' };
    if (t.type === 'tool') {
      if (typeof t.name !== 'string' || !t.name) return { err: 'tool_choice.name must be a string when type is "tool"' };
      return { val: { name: t.name } };
    }
    return { err: 'tool_choice.type must be one of auto, any, tool, none' };
  }
  if (t.type !== 'function') {
    return { err: `tool_choice: only function tool choice can be routed — '${String(t.type)}' is not supported` };
  }
  if (mode === 'responses') {
    if (typeof t.name !== 'string' || !t.name) return { err: 'tool_choice.name must be a string' };
    return { val: { name: t.name } };
  }
  const fn = t.function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return { err: 'tool_choice.function must be an object' };
  const name = (fn as Record<string, unknown>).name;
  if (typeof name !== 'string' || !name) return { err: 'tool_choice.function.name must be a string' };
  return { val: { name } };
}

// ------------------------------------------------------------------- images

/** Validates an image URL (data URL or http(s)) — the only forms every dialect can express. */
export function imageUrlValue(v: unknown, param: string): { err?: string; url?: string } {
  if (typeof v !== 'string' || !v) return { err: `${param} must be an image URL string` };
  if (v.startsWith('data:')) return { url: v };
  if (v.startsWith('http://') || v.startsWith('https://')) return { url: v };
  return { err: `${param} must be a data: URL or an http(s) URL` };
}

/** Builds a canonical image from a URL value that may be a string or `{url, detail?}`. */
export function imageOption(v: unknown, param: string): { err?: string; val?: CanonicalImage } {
  let urlVal: unknown = v;
  let detail: unknown;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    urlVal = o.url;
    detail = o.detail;
  }
  const url = imageUrlValue(urlVal, param);
  if (url.err) return { err: url.err };
  if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
    return { err: `${param}.detail must be one of auto, low, high` };
  }
  return { val: detail === undefined ? { url: url.url as string } : { url: url.url as string, detail } };
}
