// Anthropic Messages client dialect (/v1/messages) plus the anthropic half of
// cross-dialect translation. Everything wire-format for this dialect lives
// here: parsing an incoming body into the canonical request
// (src/worker/canonical.ts), the anthropic error envelope, mapping upstream
// failures into it, and translating openai-dialect completions/streams into
// anthropic messages/events (tool_calls → tool_use blocks included). The
// reverse direction (anthropic → openai shapes) lives in dialects/openaiChat.ts.
// Extended thinking remains rejected with an explicit pointer.
import type { CanonicalChatOptions, CanonicalChatRequest, CanonicalImage, CanonicalMessage, CanonicalToolCall } from '../canonical';
import { boolOption, floatOption, imageOption, intOption, stopOption, toolChoiceOption, toolDefsOption } from './options';
import { translateSseStream } from './sse';

// ------------------------------------------------------------- error envelope

export interface AnthropicErrorBody {
  type: 'error';
  error: { type: string; message: string };
}

const TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  408: 'timeout_error',
  413: 'request_too_large',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  504: 'timeout_error',
  529: 'overloaded_error',
};

export function errorTypeForStatus(status: number): string {
  // Table first: specific derivations (504 → timeout_error, 529 →
  // overloaded_error) must not be shadowed by the generic 5xx fallback.
  return TYPE_BY_STATUS[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
}

/** Builds the anthropic error envelope: `{"type":"error","error":{type,message}}`. */
export function anthropicError(status: number, message: string, opts: { type?: string } = {}): AnthropicErrorBody {
  return { type: 'error', error: { type: opts.type ?? errorTypeForStatus(status), message } };
}

/**
 * Maps openai-vocabulary error types onto the anthropic ones; unknown types
 * fall through so anthropic-native bodies keep their type untouched.
 */
const OPENAI_TO_ANTHROPIC_TYPE: Record<string, string> = {
  server_error: 'api_error',
  timeout_error: 'timeout_error',
  not_found_error: 'not_found_error',
  overloaded_error: 'overloaded_error',
  billing_error: 'billing_error',
  context_length_exceeded: 'invalid_request_error',
  model_not_found: 'not_found_error',
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  permission_error: 'permission_error',
  rate_limit_error: 'rate_limit_error',
  api_error: 'api_error',
};

function anthropicTypeForOpenAiType(type: string, status: number): string {
  return OPENAI_TO_ANTHROPIC_TYPE[type] ?? errorTypeForStatus(status);
}

/**
 * Maps an upstream failure response (openai-shaped, anthropic-shaped, or raw
 * text) into the anthropic error envelope. Preserves the upstream status and
 * message; the type is kept when the upstream declared one (the openai and
 * anthropic vocabularies overlap), with openai-only names mapped onto the
 * anthropic ones; absent types are derived from the status. The anthropic
 * SDK classifies errors by status code, so a preserved type string is safe.
 */
export function upstreamErrorToAnthropic(status: number, raw: string): AnthropicErrorBody {
  let message = '';
  let type: string | undefined;

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const errVal = obj.error; // anthropic {type:'error',error:{…}} or openai {error:{…}|'…'}
    if (errVal && typeof errVal === 'object') {
      const e = errVal as Record<string, unknown>;
      if (typeof e.message === 'string') message = e.message;
      else message = JSON.stringify(errVal).slice(0, 240);
      if (typeof e.type === 'string') type = anthropicTypeForOpenAiType(e.type, status);
    } else if (typeof errVal === 'string') {
      message = errVal;
    } else if (typeof obj.message === 'string') {
      message = obj.message;
    } else {
      message = JSON.stringify(parsed).slice(0, 240);
    }
  } else {
    message = raw.slice(0, 240);
  }
  if (!message) message = `Upstream returned HTTP ${status}.`;
  return anthropicError(status, message, { type });
}

// ------------------------------------------------------------ request parsing

export type MessagesParse =
  | { ok: true; model: string; request: CanonicalChatRequest }
  | { ok: false; status: number; message: string; param?: string | null; code?: string | null };

const ANTHROPIC_ROLES: readonly string[] = ['user', 'assistant'];
/** Extended thinking — arrives with the later reasoning work. */
const LATER_KEYS: readonly string[] = ['thinking'];

function parseErr(message: string, param?: string | null, code?: string | null): MessagesParse {
  return { ok: false, status: 400, message, param: param ?? null, code: code ?? null };
}

/** Parses an anthropic `image` content block onto a canonical image. */
function imageFromBlock(block: Record<string, unknown>, param: string): { val?: CanonicalImage; err?: string } {
  const source = block.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { err: `${param}.source must be an object` };
  }
  const src = source as Record<string, unknown>;
  if (src.type === 'url') {
    const img = imageOption(src.url, `${param}.source.url`);
    return img.err ? { err: img.err } : { val: img.val };
  }
  if (src.type === 'base64') {
    if (typeof src.media_type !== 'string' || !src.media_type.startsWith('image/')) {
      return { err: `${param}.source.media_type must be an image/* media type` };
    }
    if (typeof src.data !== 'string' || !src.data) {
      return { err: `${param}.source.data must be a base64 string` };
    }
    return { val: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  return { err: `${param}.source.type must be 'base64' or 'url'` };
}

/** Folds tool_result content (string or text/image block array) into text + images. */
function foldToolResultContent(
  content: unknown,
  param: string,
): { val: { text: string; images: CanonicalImage[] } } | { err: string } {
  if (content === undefined || content === null) return { val: { text: '', images: [] } };
  if (typeof content === 'string') return { val: { text: content, images: [] } };
  if (!Array.isArray(content)) return { err: `${param}.content must be a string or a content-block array` };
  let text = '';
  const images: CanonicalImage[] = [];
  for (const [j, raw] of content.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: `${param}.content[${j}] must be an object` };
    }
    const block = raw as Record<string, unknown>;
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return { err: `${param}.content[${j}].text must be a string` };
      text += (text ? '\n' : '') + block.text;
    } else if (block.type === 'image') {
      const img = imageFromBlock(block, `${param}.content[${j}]`);
      if (img.err) return { err: img.err };
      if (img.val) images.push(img.val);
    } else {
      return { err: `${param}.content[${j}]: unsupported tool_result block type '${String(block.type)}'` };
    }
  }
  return { val: { text, images } };
}

interface ParsedTurn {
  messages: CanonicalMessage[];
}

/**
 * Parses one anthropic messages[] entry. Text/image blocks fold into the
 * turn's message; `tool_use` blocks (assistant) become canonical toolCalls;
 * each `tool_result` block (user) becomes its own canonical tool message.
 */
function parseAnthropicTurn(rawMsg: unknown, param: string): { val: ParsedTurn } | { err: MessagesParse } {
  if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
    return { err: parseErr(`${param} must be an object`, param) };
  }
  const msg = rawMsg as Record<string, unknown>;
  if (typeof msg.role !== 'string' || !ANTHROPIC_ROLES.includes(msg.role)) {
    return { err: parseErr(`${param}.role must be 'user' or 'assistant'`, `${param}.role`) };
  }
  const out: CanonicalMessage[] = [];
  let text = '';
  const images: CanonicalImage[] = [];
  const toolCalls: CanonicalToolCall[] = [];

  const pushTurn = (): void => {
    if (text || images.length || (msg.role === 'assistant' && toolCalls.length)) {
      out.push({
        role: msg.role as 'user' | 'assistant',
        content: text,
        ...(images.length ? { images } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        extra: {},
      });
    }
  };

  if (typeof msg.content === 'string') {
    if (msg.content.length === 0) return { err: parseErr(`${param}.content must not be empty`, `${param}.content`) };
    text = msg.content;
    pushTurn();
    return { val: { messages: out } };
  }
  if (!Array.isArray(msg.content) || msg.content.length === 0) {
    return { err: parseErr(`${param}.content must be a string or a non-empty content-block array`, `${param}.content`) };
  }

  for (const [j, raw] of msg.content.entries()) {
    const pParam = `${param}.content[${j}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: parseErr(`${pParam} must be an object`, param) };
    }
    const block = raw as Record<string, unknown>;
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || block.text.length === 0) {
        return { err: parseErr(`${pParam}.text must be a non-empty string`, param) };
      }
      text += (text ? '\n' : '') + block.text;
    } else if (block.type === 'image') {
      if (msg.role !== 'user') {
        return { err: parseErr(`${pParam}: image blocks are only supported in user messages`, param) };
      }
      const img = imageFromBlock(block, pParam);
      if (img.err) return { err: parseErr(img.err, param) };
      if (img.val) images.push(img.val);
    } else if (block.type === 'tool_use') {
      if (msg.role !== 'assistant') {
        return { err: parseErr(`${pParam}: 'tool_use' blocks are only valid in assistant messages`, param) };
      }
      if (typeof block.id !== 'string' || !block.id) return { err: parseErr(`${pParam}.id must be a string`, param) };
      if (typeof block.name !== 'string' || !block.name) return { err: parseErr(`${pParam}.name must be a string`, param) };
      const input = block.input ?? {};
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { err: parseErr(`${pParam}.input must be an object`, param) };
      }
      let args: string;
      try {
        args = JSON.stringify(input) ?? '';
      } catch {
        return { err: parseErr(`${pParam}.input must be JSON-serializable`, param) };
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: args });
    } else if (block.type === 'tool_result') {
      if (msg.role !== 'user') {
        return { err: parseErr(`${pParam}: 'tool_result' blocks are only valid in user messages`, param) };
      }
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) {
        return { err: parseErr(`${pParam}.tool_use_id must be a string`, param) };
      }
      const folded = foldToolResultContent(block.content, pParam);
      if ('err' in folded) return { err: parseErr(folded.err, param) };
      out.push({
        role: 'tool',
        content: folded.val.text,
        toolCallId: block.tool_use_id,
        ...(folded.val.images.length ? { images: folded.val.images } : {}),
        ...(block.is_error === true ? { extra: { is_error: true } } : { extra: {} }),
      });
    } else if (block.type === 'document') {
      return { err: parseErr(`'document' content blocks (PDFs) are not supported yet.`, param) };
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      return { err: parseErr(`'${String(block.type)}' content blocks are not supported yet — extended thinking arrives later.`, param) };
    } else {
      return { err: parseErr(`Unsupported content block type '${String(block.type)}'`, param) };
    }
  }
  pushTurn();
  return { val: { messages: out } };
}

/**
 * Parses + validates a POST /v1/messages body into the canonical form.
 * Mirrors the Messages dialect contract: `max_tokens` is REQUIRED, `system`
 * is a top-level param (folded into a canonical system message), roles are
 * user/assistant only. M6: function tools, tool_choice, image blocks,
 * tool_use/tool_result blocks are translated; hosted tools and thinking are
 * rejected explicitly; recognized extras (`top_k`, `metadata`) ride in
 * `extras`.
 */
export async function parseAnthropicMessagesRequest(reader: { json: () => Promise<unknown> }): Promise<MessagesParse> {
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
  if (!model) return parseErr('model: field required', 'model', 'missing_required_parameter');

  // Messages requires a positive integer max_tokens — no upstream default.
  if (raw.max_tokens === undefined) {
    return parseErr('max_tokens: field required', 'max_tokens', 'missing_required_parameter');
  }
  const options: CanonicalChatOptions = {};
  const maxTokens = intOption(raw.max_tokens, 'max_tokens', 1, 1_000_000_000);
  if (maxTokens.err) return parseErr(maxTokens.err, 'max_tokens');
  options.maxTokens = maxTokens.val ?? null;
  options.maxTokensField = 'max_tokens';

  const tools = toolDefsOption(raw.tools, 'anthropic');
  if (tools.err) return parseErr(tools.err, 'tools');
  options.tools = tools.val ?? null;
  const toolChoice = toolChoiceOption(raw.tool_choice, 'anthropic');
  if (toolChoice.err) return parseErr(toolChoice.err, 'tool_choice');
  options.toolChoice = toolChoice.val ?? null;
  if (raw.tool_choice && typeof raw.tool_choice === 'object' && !Array.isArray(raw.tool_choice)) {
    const disable = (raw.tool_choice as Record<string, unknown>).disable_parallel_tool_use;
    if (disable !== undefined) {
      const d = boolOption(disable, 'tool_choice.disable_parallel_tool_use');
      if (d.err) return parseErr(d.err, 'tool_choice.disable_parallel_tool_use');
      if (d.val !== undefined && d.val !== null) options.parallelToolCalls = !d.val;
    }
  }
  for (const key of LATER_KEYS) {
    if (key in raw) {
      return parseErr(`'${key}' is not supported yet — extended thinking arrives in a later milestone.`, key);
    }
  }

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return parseErr("messages: field required (a non-empty array of user/assistant turns)", 'messages', 'missing_required_parameter');
  }
  const messages: CanonicalMessage[] = [];
  for (const [i, rawMsg] of raw.messages.entries()) {
    const turn = parseAnthropicTurn(rawMsg, `messages[${i}]`);
    if ('err' in turn) return turn.err;
    messages.push(...turn.val.messages);
  }

  // Top-level system param → canonical leading system message.
  if (raw.system !== undefined && raw.system !== null) {
    let systemText = '';
    if (typeof raw.system === 'string') {
      systemText = raw.system;
    } else if (Array.isArray(raw.system) && raw.system.length > 0) {
      for (const [j, rawBlock] of raw.system.entries()) {
        if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
          return parseErr(`system[${j}] must be an object`, 'system');
        }
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          systemText += (systemText ? '\n' : '') + block.text;
        } else {
          return parseErr(`system[${j}]: only text blocks are supported`, 'system');
        }
      }
    } else {
      return parseErr('system must be a string or a non-empty content-block array', 'system');
    }
    if (systemText) {
      messages.unshift({ role: 'system', content: systemText, extra: {} });
    }
  }

  let stream = false;
  if (raw.stream !== undefined) {
    if (typeof raw.stream !== 'boolean') return parseErr('stream must be a boolean', 'stream');
    stream = raw.stream;
  }

  const temperature = floatOption(raw.temperature, 'temperature', 0, 1); // Messages spec clamps to 0..1
  if (temperature.err) return parseErr(temperature.err, 'temperature');
  options.temperature = temperature.val;

  const topP = floatOption(raw.top_p, 'top_p', 0, 1);
  if (topP.err) return parseErr(topP.err, 'top_p');
  options.topP = topP.val;

  if (raw.stop_sequences !== undefined && raw.stop_sequences !== null) {
    const stop = stopOption(raw.stop_sequences, 16);
    if (stop.err) return parseErr('stop_sequences must be an array of at most 16 strings (≤128 chars each)', 'stop_sequences');
    options.stop = stop.val ?? [];
  } else {
    options.stop = null;
  }

  // Recognized anthropic-only fields ride along (adapters decide what fits).
  const extras: Record<string, unknown> = {};
  if (raw.top_k !== undefined) {
    const topK = intOption(raw.top_k, 'top_k', 0, 2_000_000);
    if (topK.err) return parseErr(topK.err, 'top_k');
    if (topK.val !== undefined && topK.val !== null) extras.top_k = topK.val;
  }
  if (raw.metadata !== undefined) {
    if (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
      return parseErr('metadata must be an object', 'metadata');
    }
    extras.metadata = raw.metadata;
  }

  return { ok: true, model, request: { messages, stream, options, extras } };
}

// ----------------------------------------------------- openai → anthropic wire

function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** Maps an openai finish_reason onto the anthropic stop_reason vocabulary. */
export function mapFinishReasonToStopReason(finish: unknown): string {
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter': // anthropic has no such concept — closest is a normal end
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** Folds openai message content (string or text-part array) into plain text. */
function foldOpenAiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
        const t = (part as Record<string, unknown>).text;
        if (typeof t === 'string') text += (text ? '\n' : '') + t;
      }
      // image parts cannot occur — Khateway rejects them at parse time (M6)
    }
    return text;
  }
  return '';
}

/** Parses openai tool-call arguments (JSON string) into the anthropic input object. */
export function argumentsToToolInput(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const v: unknown = JSON.parse(args);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

/** Renders one anthropic SSE event block. */
function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Translates an openai chat.completion JSON body into an anthropic Message.
 * `message.tool_calls` become tool_use content blocks (arguments parsed into
 * the input object). `model` is the caller-facing model (the requested slug).
 */
export function openAiCompletionToAnthropicMessage(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
  const first = choices[0] ?? {};
  const message = (first.message ?? {}) as Record<string, unknown>;
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const id = typeof payload.id === 'string' ? `msg_${payload.id.replace(/^chatcmpl-/, '')}` : 'msg_khateway';
  const text = foldOpenAiContent(message.content);
  const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
  const toolCalls = rawCalls.filter(
    (tc) => tc && typeof tc === 'object' && typeof (tc as Record<string, unknown>).id === 'string',
  );
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of toolCalls) {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name !== 'string' || !fn.name) continue;
    content.push({ type: 'tool_use', id: tc.id, name: fn.name, input: argumentsToToolInput(fn.arguments) });
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReasonToStopReason(first.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: toInt(usage.prompt_tokens), output_tokens: toInt(usage.completion_tokens) },
  };
}

/**
 * Translates an openai chat.completion SSE chunk stream into an anthropic
 * Messages event stream (client-side dialect: anthropic). Emits
 * message_start → content_block_start → text deltas → content_block_stop →
 * message_delta (stop reason + usage) → message_stop. Mid-stream openai
 * error chunks become anthropic `error` events. Usage input tokens are only
 * known when the upstream sends a usage chunk (stream_options) — until then
 * 0 is reported, mirroring how little openai reveals mid-stream.
 */
export function transformOpenAiSseToAnthropic(src: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    let started = false;
    let closed = false;
    let id = 'msg_khateway';
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    // openai delta.tool_calls[] index → anthropic tool_use block (text block is index 0)
    const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string }>();
    let nextBlockIndex = 1;

    const emitStart = () => {
      if (started) return;
      started = true;
      out.enqueue(
        sse('message_start', {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      out.enqueue(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    };

    /** Opens (once) + streams one openai tool-call entry as a tool_use block. */
    const emitToolDelta = (entry: Record<string, unknown>): void => {
      const idx = typeof entry.index === 'number' ? entry.index : 0;
      let block = toolBlocks.get(idx);
      const fn = (entry.function ?? {}) as Record<string, unknown>;
      if (!block) {
        block = {
          blockIndex: nextBlockIndex++,
          id: typeof entry.id === 'string' && entry.id ? entry.id : `call_${idx}`,
          name: typeof fn.name === 'string' ? fn.name : '',
        };
        toolBlocks.set(idx, block);
        out.enqueue(
          sse('content_block_start', {
            type: 'content_block_start',
            index: block.blockIndex,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          }),
        );
      }
      if (typeof fn.arguments === 'string' && fn.arguments) {
        out.enqueue(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: fn.arguments },
          }),
        );
      }
    };

    const emitCompletion = () => {
      if (closed) return;
      closed = true;
      if (!started) {
        out.enqueue(sse('error', { type: 'error', error: { type: 'api_error', message: 'Upstream stream ended without content.' } }));
        return;
      }
      out.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      for (const block of [...toolBlocks.values()].sort((a, b) => a.blockIndex - b.blockIndex)) {
        out.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: block.blockIndex }));
      }
      out.enqueue(
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
      );
      out.enqueue(sse('message_stop', { type: 'message_stop' }));
    };

    return {
      onEvent(ev) {
        if (closed) return;
        if (ev.data === '[DONE]') {
          emitCompletion();
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
          out.enqueue(
            sse('error', {
              type: 'error',
              error: {
                type: typeof e.type === 'string' ? e.type : 'api_error',
                message: typeof e.message === 'string' ? e.message : 'Upstream stream error.',
              },
            }),
          );
          closed = true;
          return;
        }
        if (typeof payload.id === 'string' && payload.id) id = `msg_${payload.id.replace(/^chatcmpl-/, '')}`;
        const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
        const choice = choices[0];
        if (!choice) {
          const usage = payload.usage as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = toInt(usage.prompt_tokens);
            outputTokens = toInt(usage.completion_tokens);
          }
          return;
        }
        emitStart();
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === 'string' && delta.content) {
          out.enqueue(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } }));
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls as unknown[]) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) emitToolDelta(entry as Record<string, unknown>);
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          stopReason = mapFinishReasonToStopReason(choice.finish_reason);
        }
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = toInt(usage.prompt_tokens);
          outputTokens = toInt(usage.completion_tokens);
        }
      },
      onEnd() {
        emitCompletion();
      },
    };
  });
}
