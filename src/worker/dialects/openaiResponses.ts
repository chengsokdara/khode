// OpenAI Responses client dialect (/v1/responses) plus the responses half of
// cross-dialect translation. Everything wire-format for this dialect lives
// here: parsing an incoming body into the canonical request
// (src/worker/canonical.ts), and translating openai chat completions /
// anthropic messages (JSON and SSE) back out as Responses API objects and
// events. Per plan §2 there is no responses-dialect *upstream* adapter — the
// upstreams stay chat-completions + Messages — so EVERY /v1/responses
// pairing is translated; there is no passthrough cell, and responses-only
// request params that have no canonical home (store, truncation, include,
// text, service_tier, metadata, …) are dropped deliberately rather than
// forwarded to a different dialect upstream.
//
// Dialect-faithful rejections: stateful features Khateway cannot honor
// (previous_response_id, prompt, item_reference) and vendor-hosted tools /
// reasoning fail with an explicit 400 pointer — never silently mis-shaped.
// Errors use the OpenAI error envelope (shared with the chat dialect;
// rendered by routes/gateway.ts via openAiError).
import type { CanonicalChatOptions, CanonicalChatRequest, CanonicalImage, CanonicalMessage, CanonicalReasoning, CanonicalResponseFormat, CanonicalRole, CanonicalToolCall } from '../canonical';
import { boolOption, canonicalReasoning, canonicalReasoningContent, floatOption, imageOption, intOption, reasoningEffortOption, responseFormatOption, toolChoiceOption, toolDefsOption } from './options';
import { toolInputToArguments } from './openaiChat';
import { translateSseStream, type SseOut } from './sse';

// ------------------------------------------------------------ request parsing

export type ResponsesParse =
  | { ok: true; model: string; request: CanonicalChatRequest }
  | { ok: false; status: number; message: string; param?: string | null; code?: string | null };

const KNOWN_ROLES: readonly string[] = ['system', 'developer', 'user', 'assistant'];
/** Server-side conversation/prompt state Khateway does not store. */
const STATE_KEYS: readonly string[] = ['previous_response_id', 'prompt'];

function parseErr(message: string, param?: string | null, code?: string | null): ResponsesParse {
  return { ok: false, status: 400, message, param: param ?? null, code: code ?? null };
}

/** Folds a Responses message content-part array into text + images. */
function foldContentParts(parts: unknown, param: string): { val: { text: string; images: CanonicalImage[] } } | { err: ResponsesParse } {
  let text = '';
  const images: CanonicalImage[] = [];
  for (const [j, raw] of (parts as unknown[]).entries()) {
    const pParam = `${param}[${j}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: parseErr(`${pParam} must be an object`, param) };
    }
    const part = raw as Record<string, unknown>;
    if (part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') return { err: parseErr(`${pParam}.text must be a string`, param) };
      text += (text ? '\n' : '') + part.text;
    } else if (part.type === 'refusal') {
      if (typeof part.refusal !== 'string') return { err: parseErr(`${pParam}.refusal must be a string`, param) };
      text += (text ? '\n' : '') + part.refusal;
    } else if (part.type === 'input_image') {
      const img = imageOption(part.image_url, `${pParam}.image_url`);
      if (img.err) return { err: parseErr(img.err, param) };
      if (img.val) images.push(img.val);
    } else {
      return { err: parseErr(`Unsupported content part type '${String(part.type)}'`, param) };
    }
  }
  return { val: { text, images } };
}

/**
 * Parses + validates a POST /v1/responses body into the canonical form.
 * `input` is a string or an array of input items (messages, function_call,
 * function_call_output); `instructions` folds into a leading canonical system
 * message; `max_output_tokens` (Responses' required-≥16 cap, optional here)
 * maps onto the canonical maxTokens with the downstream field `max_tokens`
 * (the most portable name across openai-compatible upstreams; the Messages
 * adapter always emits max_tokens anyway). M6: function tools, tool_choice,
 * parallel_tool_calls, image parts and function_call items are translated.
 * Stateful params and vendor-hosted tools are rejected with explicit pointers.
 */
export async function parseOpenAiResponsesRequest(reader: { json: () => Promise<unknown> }): Promise<ResponsesParse> {
  let body: unknown;
  try {
    body = await reader.json();
  } catch {
    return parseErr('Request body must be valid JSON', null, 'invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return parseErr('Request body must be a JSON object', null, 'invalid_json');
  }
  const raw = body as Record<string, unknown>;

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return parseErr('Missing parameter: model is required', 'model', 'missing_required_parameter');

  const options: CanonicalChatOptions = {};
  const tools = toolDefsOption(raw.tools, 'responses');
  if (tools.err) return parseErr(tools.err, 'tools');
  options.tools = tools.val ?? null;
  const toolChoice = toolChoiceOption(raw.tool_choice, 'responses');
  if (toolChoice.err) return parseErr(toolChoice.err, 'tool_choice');
  options.toolChoice = toolChoice.val ?? null;
  const parallel = boolOption(raw.parallel_tool_calls, 'parallel_tool_calls');
  if (parallel.err) return parseErr(parallel.err, 'parallel_tool_calls');
  options.parallelToolCalls = parallel.val ?? null;

  // M17: the reasoning param parses onto canonical reasoning (effort only;
  // `summary` is accepted and honored implicitly — upstream reasoning is
  // always surfaced as reasoning output items / summary deltas when present).
  let reasoning: CanonicalReasoning | null = null;
  if (raw.reasoning !== undefined && raw.reasoning !== null) {
    if (!raw.reasoning || typeof raw.reasoning !== 'object' || Array.isArray(raw.reasoning)) {
      return parseErr('reasoning must be an object', 'reasoning');
    }
    const r = raw.reasoning as Record<string, unknown>;
    if (r.effort !== undefined && r.effort !== null) {
      const effort = reasoningEffortOption(r.effort, 'reasoning.effort');
      if (effort.err) return parseErr(effort.err, 'reasoning.effort');
      reasoning = canonicalReasoning(effort.val);
    }
  }

  // M18: text.format → canonical responseFormat ({type:'text'} → none).
  let responseFormat: CanonicalResponseFormat | null = null;
  if (raw.text !== undefined && raw.text !== null) {
    if (!raw.text || typeof raw.text !== 'object' || Array.isArray(raw.text)) {
      return parseErr('text must be an object', 'text');
    }
    const fmt = responseFormatOption((raw.text as Record<string, unknown>).format, 'text.format', 'responses');
    if (fmt.err) return parseErr(fmt.err, 'text.format');
    responseFormat = fmt.val ?? null;
  }
  for (const key of STATE_KEYS) {
    if (key in raw) {
      return parseErr(`'${key}' is not supported — Khateway is a stateless router and does not store conversations or prompt templates.`, key);
    }
  }

  const messages: CanonicalMessage[] = [];
  if (raw.input === undefined) {
    return parseErr("Missing parameter: 'input' is required", 'input', 'missing_required_parameter');
  }
  if (typeof raw.input === 'string') {
    if (raw.input.length === 0) return parseErr("'input' must not be empty", 'input');
    messages.push({ role: 'user', content: raw.input, extra: {} });
  } else if (Array.isArray(raw.input)) {
    if (raw.input.length === 0) {
      return parseErr("'input' must be a non-empty array of input items or a string", 'input');
    }
    for (const [i, rawItem] of raw.input.entries()) {
      const param = `input[${i}]`;
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return parseErr(`${param} must be an object`, param);
      }
      const item = rawItem as Record<string, unknown>;
      // Easy-input messages omit `type` (message is implied).
      const itemType = typeof item.type === 'string' ? item.type : 'message';
      if (itemType === 'function_call') {
        if (typeof item.name !== 'string' || !item.name) return parseErr(`${param}.name must be a string`, param);
        const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : typeof item.id === 'string' ? item.id : '';
        if (!callId) return parseErr(`${param}.call_id must be a string`, param);
        if (item.arguments !== undefined && item.arguments !== null && typeof item.arguments !== 'string') {
          return parseErr(`${param}.arguments must be a JSON string`, param);
        }
        const call: CanonicalToolCall = { id: callId, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '' };
        messages.push({ role: 'assistant', content: '', toolCalls: [call], extra: {} });
        continue;
      }
      if (itemType === 'function_call_output') {
        const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : '';
        if (!callId) return parseErr(`${param}.call_id must be a string`, param);
        let text = '';
        const images: CanonicalImage[] = [];
        if (typeof item.output === 'string') {
          text = item.output;
        } else if (Array.isArray(item.output)) {
          const folded = foldContentParts(item.output, `${param}.output`);
          if ('err' in folded) return folded.err;
          text = folded.val.text;
          images.push(...folded.val.images);
        } else if (item.output !== undefined && item.output !== null) {
          return parseErr(`${param}.output must be a string or a content-part array`, param);
        }
        messages.push({
          role: 'tool',
          content: text,
          toolCallId: callId,
          ...(images.length ? { images } : {}),
          extra: {},
        });
        continue;
      }
      if (itemType === 'item_reference') {
        return parseErr(`'item_reference' input items are not supported — Khateway does not store previous responses.`, param);
      }
      if (itemType === 'reasoning') {
        // M17: reasoning input items parse onto an assistant message carrying
        // canonical reasoning (summary text only; the model regenerates its
        // own thinking — history reasoning is context, not instructions).
        let summaryText = '';
        if (Array.isArray(item.summary)) {
          for (const rawPart of item.summary as unknown[]) {
            const part = rawPart && typeof rawPart === 'object' ? (rawPart as Record<string, unknown>) : null;
            if (part && part.type === 'summary_text' && typeof part.text === 'string' && part.text) {
              summaryText += (summaryText ? '\n' : '') + part.text;
            }
          }
        }
        if (summaryText) {
          messages.push({
            role: 'assistant',
            content: '',
            reasoning: canonicalReasoningContent({ text: summaryText }),
            extra: {},
          });
        }
        continue;
      }
      if (itemType !== 'message') {
        return parseErr(`Unsupported input item type '${itemType}'`, param);
      }
      if (typeof item.role !== 'string' || !KNOWN_ROLES.includes(item.role)) {
        return parseErr(`${param}.role must be one of system, developer, user, assistant`, `${param}.role`);
      }
      let content: string;
      const images: CanonicalImage[] = [];
      if (typeof item.content === 'string') {
        if (item.content.length === 0) return parseErr(`${param}.content must not be empty`, `${param}.content`);
        content = item.content;
      } else if (Array.isArray(item.content) && item.content.length > 0) {
        const folded = foldContentParts(item.content, `${param}.content`);
        if ('err' in folded) return folded.err;
        content = folded.val.text;
        images.push(...folded.val.images);
      } else {
        return parseErr(`${param}.content must be a string or a non-empty content-part array`, `${param}.content`);
      }
      messages.push({
        role: item.role as CanonicalRole,
        content,
        ...(images.length ? { images } : {}),
        extra: {},
      });
    }
  } else {
    return parseErr("'input' must be a string or an array of input items", 'input');
  }

  // Top-level instructions param → canonical leading system message.
  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== 'string') return parseErr('instructions must be a string', 'instructions');
    if (raw.instructions) {
      messages.unshift({ role: 'system', content: raw.instructions, extra: {} });
    }
  }

  let stream = false;
  if (raw.stream !== undefined) {
    if (typeof raw.stream !== 'boolean') return parseErr('stream must be a boolean', 'stream');
    stream = raw.stream;
  }

  const temperature = floatOption(raw.temperature, 'temperature', 0, 2);
  if (temperature.err) return parseErr(temperature.err, 'temperature');
  options.temperature = temperature.val;

  const topP = floatOption(raw.top_p, 'top_p', 0, 1);
  if (topP.err) return parseErr(topP.err, 'top_p');
  options.topP = topP.val;

  const maxOut = intOption(raw.max_output_tokens, 'max_output_tokens', 16, 1_000_000_000);
  if (maxOut.err) return parseErr('max_output_tokens must be an integer between 16 and 1000000000', 'max_output_tokens');
  if (maxOut.val !== undefined && maxOut.val !== null) {
    options.maxTokens = maxOut.val;
    options.maxTokensField = 'max_tokens';
  }

  // No extras: responses-only params would be rejected by the translated
  // upstream dialects, so everything unconsumed above is dropped (see header).
  return { ok: true, model, request: { messages, stream, ...(reasoning ? { reasoning } : {}), ...(responseFormat ? { responseFormat } : {}), options, extras: {} } };
}

// ------------------------------------------------ responses ← upstream (JSON)

function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

interface StatusOutcome {
  status: 'completed' | 'incomplete';
  reason: string | null;
}

/** Maps an openai finish_reason onto a Responses status + incomplete_details. */
function responseStatusForFinish(finish: unknown): StatusOutcome {
  switch (finish) {
    case 'length':
      return { status: 'incomplete', reason: 'max_output_tokens' };
    case 'content_filter':
      return { status: 'incomplete', reason: 'content_filter' };
    default:
      return { status: 'completed', reason: null }; // 'stop' / 'tool_calls' (defensive)
  }
}

/** Maps an anthropic stop_reason onto a Responses status + incomplete_details. */
function responseStatusForStopReason(stop: unknown): StatusOutcome {
  switch (stop) {
    case 'max_tokens':
      return { status: 'incomplete', reason: 'max_output_tokens' };
    case 'refusal':
      return { status: 'incomplete', reason: 'content_filter' };
    default:
      return { status: 'completed', reason: null }; // end_turn / stop_sequence / tool_use (defensive)
  }
}

/** Folds openai message content (string or text/refusal-part array) into plain text. */
function textOfOpenAiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') text += (text ? '\n' : '') + p.text;
      if (p.type === 'refusal' && typeof p.refusal === 'string') text += (text ? '\n' : '') + p.refusal;
    }
    return text;
  }
  return '';
}

function outputMessageItem(id: string, text: string, status: 'completed' | 'in_progress'): Record<string, unknown> {
  return {
    type: 'message',
    id,
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

/** Responses function_call output item (the model's tool invocation). */
function functionCallItem(id: string, callId: string, name: string, args: string, status: 'completed' | 'in_progress'): Record<string, unknown> {
  return { type: 'function_call', id, call_id: callId, name, arguments: args, status };
}

/** `call_abc123` → `fc_abc123` style item ids derived from the call id. */
function functionCallItemId(callId: string): string {
  return `fc_${callId.replace(/^(call_|fc_)/, '') || 'khateway'}`;
}

function responseUsage(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function responseObject(opts: {
  id: string;
  createdAt: number;
  model: string;
  status: string;
  reason: string | null;
  items: Record<string, unknown>[];
  usage: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: opts.id,
    object: 'response',
    created_at: opts.createdAt,
    status: opts.status,
    model: opts.model,
    output: opts.items,
    error: null,
    incomplete_details: opts.reason ? { reason: opts.reason } : null,
    usage: opts.usage,
  };
}

/** Extracts openai `message.tool_calls` onto Responses function_call items. */
function toolCallsToFunctionCallItems(rawCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawCalls)) return [];
  const items: Record<string, unknown>[] = [];
  for (const raw of rawCalls as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const tc = raw as Record<string, unknown>;
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    if (typeof tc.id !== 'string' || !tc.id || typeof fn.name !== 'string' || !fn.name) continue;
    items.push(
      functionCallItem(
        functionCallItemId(tc.id),
        tc.id,
        fn.name,
        typeof fn.arguments === 'string' ? fn.arguments : '',
        'completed',
      ),
    );
  }
  return items;
}

/** M17: upstream reasoning text → a Responses reasoning output item. */
function reasoningItem(id: string, text: string): Record<string, unknown> {
  return { id, type: 'reasoning', summary: [{ type: 'summary_text', text }] };
}

/**
 * Translates an openai chat.completion JSON body into a Responses API object.
 * `message.tool_calls` become function_call output items; M17
 * `message.reasoning_content` becomes a reasoning output item leading the
 * message. `model` is the caller-facing model (the requested slug).
 */
export function openAiCompletionToResponse(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
  const first = choices[0] ?? {};
  const message = (first.message ?? {}) as Record<string, unknown>;
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const { status, reason } = responseStatusForFinish(first.finish_reason);
  const suffix = typeof payload.id === 'string' && payload.id ? payload.id.replace(/^chatcmpl-/, '') : 'khateway';
  const text = textOfOpenAiContent(message.content);
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const callItems = toolCallsToFunctionCallItems(message.tool_calls);
  const items: Record<string, unknown>[] = [];
  if (reasoning) items.push(reasoningItem(`rs_${suffix}`, reasoning));
  if (text || callItems.length === 0) {
    items.push(outputMessageItem(`msg_${suffix}`, text, 'completed'));
  }
  items.push(...callItems);
  return responseObject({
    id: `resp_${suffix}`,
    createdAt: typeof payload.created === 'number' ? payload.created : Math.floor(Date.now() / 1000),
    model,
    status,
    reason,
    items,
    usage: responseUsage(toInt(usage.prompt_tokens), toInt(usage.completion_tokens)),
  });
}

/**
 * Translates an anthropic Message JSON body into a Responses API object.
 * Text blocks fold into one output_text part; tool_use blocks become
 * function_call output items; M17 thinking blocks become a reasoning output
 * item leading the message. `model` is the caller-facing model (the
 * requested slug).
 */
export function anthropicMessageToResponse(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const blocks = Array.isArray(payload.content) ? (payload.content as Record<string, unknown>[]) : [];
  let text = '';
  let reasoning = '';
  const callItems: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      reasoning += (reasoning ? '\n' : '') + block.thinking;
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      callItems.push(
        functionCallItem(
          functionCallItemId(block.id),
          block.id,
          block.name,
          toolInputToArguments(block.input),
          'completed',
        ),
      );
    }
    // redacted_thinking blocks carry no client-visible text — dropped here
  }
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const { status, reason } = responseStatusForStopReason(payload.stop_reason);
  const suffix = typeof payload.id === 'string' && payload.id ? payload.id.replace(/^msg_/, '') : 'khateway';
  const items: Record<string, unknown>[] = [];
  if (reasoning) items.push(reasoningItem(`rs_${suffix}`, reasoning));
  if (text || callItems.length === 0) {
    items.push(outputMessageItem(`msg_${suffix}`, text, 'completed'));
  }
  items.push(...callItems);
  return responseObject({
    id: `resp_${suffix}`,
    createdAt: Math.floor(Date.now() / 1000),
    model,
    status,
    reason,
    items,
    usage: responseUsage(toInt(usage.input_tokens), toInt(usage.output_tokens)),
  });
}

// ---------------------------------------------- responses ← upstream (SSE)

/**
 * Emits the Responses SSE event sequence shared by both upstream translators:
 * response.created → [message item: response.output_item.added →
 * response.content_part.added → response.output_text.delta* →
 * response.output_text.done → response.content_part.done →
 * response.output_item.done] → [function_call items: response.output_item.added
 * → response.function_call_arguments.delta* →
 * response.function_call_arguments.done → response.output_item.done] →
 * response.completed. Every event carries a monotonic sequence_number.
 * The message item is opened lazily (only when text actually streams) so
 * tool-call-only turns produce function_call-only output; upstream errors and
 * streams with no content at all emit response.failed.
 */
function makeResponsesStream(out: SseOut, model: string) {
  const createdAt = Math.floor(Date.now() / 1000);
  let respId = 'resp_khateway';
  let itemId = 'msg_khateway';
  let reasoningItemId = 'rs_khateway';
  let seq = 0;
  let created = false;
  let opened = false; // message item added
  let reasoningOpened = false; // M17 reasoning item added
  let reasoningDone = false;
  let reasoningText = '';
  let reasoningOutIndex = -1;
  let closed = false;
  let text = '';
  let nextOutIndex = 0;
  let messageOutIndex = 0;
  const calls: { itemId: string; callId: string; name: string; args: string; outIndex: number }[] = [];
  const callByCallId = new Map<string, (typeof calls)[number]>();

  const next = (): number => seq++;
  const emit = (event: string, payload: Record<string, unknown>): void => {
    out.enqueue(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const skeleton = (status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: respId,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output: [],
    error: null,
    incomplete_details: null,
    usage: null,
    ...overrides,
  });
  const messageItem = (t: string, status: 'completed' | 'in_progress'): Record<string, unknown> =>
    outputMessageItem(itemId, t, status);

  /** Emits `response.created` once — always the first event of the stream. */
  const begin = (): void => {
    if (created || closed) return;
    created = true;
    emit('response.created', { type: 'response.created', sequence_number: next(), response: skeleton('in_progress') });
  };

  /** Opens the assistant message item (lazy — only when text streams). */
  const openMessage = (): void => {
    begin();
    if (opened || closed) return;
    opened = true;
    messageOutIndex = nextOutIndex++;
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: messageOutIndex,
      item: messageItem('', 'in_progress'),
    });
    emit('response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: next(),
      item_id: itemId,
      output_index: messageOutIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  /** Opens (once) the M17 reasoning item — always before the message item. */
  const openReasoning = (): void => {
    begin();
    if (reasoningOpened || closed) return;
    reasoningOpened = true;
    reasoningOutIndex = nextOutIndex++;
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: next(),
      output_index: reasoningOutIndex,
      item: { id: reasoningItemId, type: 'reasoning', summary: [] },
    });
    emit('response.reasoning_summary_part.added', {
      type: 'response.reasoning_summary_part.added',
      sequence_number: next(),
      item_id: reasoningItemId,
      output_index: reasoningOutIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  };

  /** Finalizes the reasoning item (summary text/part + output_item .done), if open. */
  const finalizeReasoning = (): void => {
    if (!reasoningOpened || reasoningDone || closed) return;
    reasoningDone = true;
    emit('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      sequence_number: next(),
      item_id: reasoningItemId,
      output_index: reasoningOutIndex,
      summary_index: 0,
      text: reasoningText,
    });
    emit('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      sequence_number: next(),
      item_id: reasoningItemId,
      output_index: reasoningOutIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningText },
    });
    emit('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: next(),
      output_index: reasoningOutIndex,
      item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningText }] },
    });
  };

  /** Finalizes the message item (its three .done events), if open and not yet done. */
  const finalizeMessage = (): void => {
    if (!opened || closed) return;
    const outIndex = messageOutIndex;
    emit('response.output_text.done', {
      type: 'response.output_text.done',
      sequence_number: next(),
      item_id: itemId,
      output_index: outIndex,
      content_index: 0,
      text,
    });
    emit('response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: next(),
      item_id: itemId,
      output_index: outIndex,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    emit('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: next(),
      output_index: outIndex,
      item: messageItem(text, 'completed'),
    });
  };

  return {
    /** True once the stream emitted a terminal event (completed or failed). */
    get closed(): boolean {
      return closed;
    },
    /** Adopts the upstream id once (chatcmpl-… / msg_… → resp_… / msg_…). */
    setId(raw: unknown): void {
      if (created || typeof raw !== 'string' || !raw) return;
      respId = `resp_${raw.replace(/^(chatcmpl-|msg_|resp_)/, '') || 'khateway'}`;
      itemId = `msg_${respId.slice('resp_'.length)}`;
      reasoningItemId = `rs_${respId.slice('resp_'.length)}`;
    },
    /** Opens + streams one tool invocation (function_call output item). */
    addToolCall(callId: string, name: string): void {
      if (closed || !callId) return;
      finalizeReasoning();
      finalizeMessage();
      begin();
      const state = {
        itemId: functionCallItemId(callId),
        callId,
        name,
        args: '',
        outIndex: nextOutIndex++,
      };
      calls.push(state);
      callByCallId.set(callId, state);
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: next(),
        output_index: state.outIndex,
        item: functionCallItem(state.itemId, callId, name, '', 'in_progress'),
      });
    },
    /** Streams one tool-arguments fragment (matched by call id, else the last call). */
    toolDelta(callId: string | null, fragment: string): void {
      if (closed || !fragment) return;
      const state = (callId ? callByCallId.get(callId) : undefined) ?? calls[calls.length - 1];
      if (!state) return;
      state.args += fragment;
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        sequence_number: next(),
        item_id: state.itemId,
        output_index: state.outIndex,
        delta: fragment,
      });
    },
    /** Streams one upstream reasoning fragment (thinking/reasoning_content). */
    reasoningDelta(t: string): void {
      if (closed || !t) return;
      if (!reasoningDone) {
        openReasoning();
        reasoningText += t;
        emit('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: next(),
          item_id: reasoningItemId,
          output_index: reasoningOutIndex,
          summary_index: 0,
          delta: t,
        });
      }
    },
    delta(t: string): void {
      if (closed || !t) return;
      finalizeReasoning();
      openMessage();
      text += t;
      emit('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: next(),
        item_id: itemId,
        output_index: messageOutIndex,
        content_index: 0,
        delta: t,
      });
    },
    close(status: StatusOutcome, usage: { input_tokens: number; output_tokens: number }): void {
      if (closed) return;
      if (!created || (!opened && calls.length === 0 && !reasoningOpened)) {
        this.fail('Upstream stream ended without content.');
        return;
      }
      finalizeMessage(); // before closed flips — its guard checks `closed`
      finalizeReasoning(); // same — must run before `closed` flips
      closed = true;
      for (const c of calls) {
        emit('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          sequence_number: next(),
          item_id: c.itemId,
          output_index: c.outIndex,
          arguments: c.args,
        });
        emit('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: next(),
          output_index: c.outIndex,
          item: functionCallItem(c.itemId, c.callId, c.name, c.args, 'completed'),
        });
      }
      // M17: a reasoning-only stream is valid output (summary, no message).
      const output: Record<string, unknown>[] = [];
      if (reasoningOpened) {
        output.push({ id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningText }] });
      }
      if (opened) output.push(messageItem(text, 'completed'));
      for (const c of calls) output.push(functionCallItem(c.itemId, c.callId, c.name, c.args, 'completed'));
      emit('response.completed', {
        type: 'response.completed',
        sequence_number: next(),
        response: skeleton(status.status, {
          output,
          incomplete_details: status.reason ? { reason: status.reason } : null,
          usage: responseUsage(usage.input_tokens, usage.output_tokens),
        }),
      });
    },
    fail(message: string, code?: string): void {
      if (closed) return;
      closed = true;
      emit('response.failed', {
        type: 'response.failed',
        sequence_number: next(),
        response: skeleton('failed', { error: { code: code ?? 'upstream_error', message } }),
      });
    },
  };
}

/**
 * Translates an openai chat.completion.chunk SSE stream into a Responses
 * event stream (client-side dialect: responses). Usage arrives only when the
 * upstream sends a usage chunk (stream_options) — until then zeros, mirroring
 * how little openai reveals mid-stream.
 */
export function transformOpenAiSseToResponses(src: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    const stream = makeResponsesStream(out, model);
    const usage = { input_tokens: 0, output_tokens: 0 };
    let status: StatusOutcome | null = null;
    // openai delta.tool_calls[] index → canonical call id (fragments omit the id)
    const callIdByIndex = new Map<number, string>();

    const readUsage = (payload: Record<string, unknown>): void => {
      const u = payload.usage as Record<string, unknown> | undefined;
      if (u) {
        usage.input_tokens = toInt(u.prompt_tokens);
        usage.output_tokens = toInt(u.completion_tokens);
      }
    };
    const finish = (): void => {
      stream.close(status ?? { status: 'completed', reason: null }, usage);
    };

    return {
      onEvent(ev) {
        if (stream.closed) return;
        if (ev.data === '[DONE]') {
          finish();
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return; // skip malformed events
        }
        if (payload.error && typeof payload.error === 'object') {
          const e = payload.error as Record<string, unknown>;
          stream.fail(
            typeof e.message === 'string' ? e.message : 'Upstream stream error.',
            typeof e.type === 'string' ? e.type : undefined,
          );
          return;
        }
        stream.setId(typeof payload.id === 'string' ? payload.id : undefined);
        const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
        const choice = choices[0];
        if (!choice) {
          readUsage(payload);
          return;
        }
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) stream.reasoningDelta(delta.reasoning_content);
        if (typeof delta.content === 'string' && delta.content) stream.delta(delta.content);
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls as unknown[]) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
            const entry = raw as Record<string, unknown>;
            const idx = typeof entry.index === 'number' ? entry.index : 0;
            const fn = (entry.function ?? {}) as Record<string, unknown>;
            let callId = callIdByIndex.get(idx);
            if (!callId && typeof entry.id === 'string' && entry.id) {
              callId = entry.id;
              callIdByIndex.set(idx, callId);
              stream.addToolCall(callId, typeof fn.name === 'string' ? fn.name : '');
            }
            if (callId && typeof fn.arguments === 'string' && fn.arguments) {
              stream.toolDelta(callId, fn.arguments);
            }
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          status = responseStatusForFinish(choice.finish_reason);
        }
        readUsage(payload);
      },
      onEnd() {
        finish();
      },
    };
  });
}

/**
 * Translates an anthropic Messages SSE stream into a Responses event stream
 * (client-side dialect: responses). input_tokens are captured from
 * message_start, output_tokens from message_delta.
 */
export function transformAnthropicSseToResponses(src: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    const stream = makeResponsesStream(out, model);
    const usage = { input_tokens: 0, output_tokens: 0 };
    let status: StatusOutcome = { status: 'completed', reason: null };
    // anthropic content-block index → tool call id (input_json_delta omits it)
    const callIdByBlock = new Map<number, string>();

    return {
      onEvent(ev) {
        if (stream.closed) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return; // skip malformed events
        }
        switch (payload.type) {
          case 'message_start': {
            const message = (payload.message ?? {}) as Record<string, unknown>;
            stream.setId(typeof message.id === 'string' ? message.id : undefined);
            const u = (message.usage ?? {}) as Record<string, unknown>;
            usage.input_tokens = toInt(u.input_tokens);
            break;
          }
          case 'content_block_start': {
            const block = (payload.content_block ?? {}) as Record<string, unknown>;
            if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
              const blockIndex = typeof payload.index === 'number' ? payload.index : callIdByBlock.size;
              callIdByBlock.set(blockIndex, block.id);
              stream.addToolCall(block.id, typeof block.name === 'string' ? block.name : '');
            }
            break;
          }
          case 'content_block_delta': {
            const delta = (payload.delta ?? {}) as Record<string, unknown>;
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              stream.delta(delta.text);
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
              // M17: anthropic thinking → reasoning summary deltas.
              stream.reasoningDelta(delta.thinking);
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
              const callId = callIdByBlock.get(typeof payload.index === 'number' ? payload.index : -1);
              if (callId) stream.toolDelta(callId, delta.partial_json);
            }
            // thinking_delta arrives with the later reasoning work
            break;
          }
          case 'message_delta': {
            const delta = (payload.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.stop_reason === 'string') status = responseStatusForStopReason(delta.stop_reason);
            const u = (payload.usage ?? {}) as Record<string, unknown>;
            usage.output_tokens = toInt(u.output_tokens);
            break;
          }
          case 'message_stop': {
            stream.close(status, usage);
            break;
          }
          case 'error': {
            const e = (payload.error ?? {}) as Record<string, unknown>;
            stream.fail(
              typeof e.message === 'string' ? e.message : 'Upstream stream error.',
              typeof e.type === 'string' ? e.type : undefined,
            );
            break;
          }
          // content_block_start(text)/stop and ping have no responses equivalent
        }
      },
      onEnd() {
        stream.close(status, usage); // no-op when message_stop already closed the stream
      },
    };
  });
}
