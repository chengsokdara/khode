// OpenAI Chat Completions client dialect (/v1/chat/completions). Everything
// wire-format for this dialect lives here: parsing an incoming body into the
// canonical request (src/worker/canonical.ts), error envelopes in the OpenAI
// error JSON shape, mapping upstream failures into that shape, and the M4
// cross-dialect half that translates anthropic messages/streams into openai
// completions/chunks (the reverse lives in dialects/anthropicMessages.ts).
import type { CanonicalChatOptions, CanonicalChatRequest, CanonicalImage, CanonicalMessage, CanonicalRole, CanonicalToolCall } from '../canonical';
import { boolOption, floatOption, imageOption, intOption, stopOption, toolChoiceOption, toolDefsOption } from './options';
import { translateSseStream } from './sse';

export interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

const TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'invalid_request_error',
  409: 'invalid_request_error',
  413: 'invalid_request_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
};

export function errorTypeForStatus(status: number): string {
  if (status >= 500) return 'api_error';
  return TYPE_BY_STATUS[status] ?? 'invalid_request_error';
}

/** Builds the OpenAI error envelope: `{"error": {message, type, param, code}}`. */
export function openAiError(
  status: number,
  message: string,
  opts: { type?: string; param?: string | null; code?: string | null } = {},
): OpenAiErrorBody {
  return {
    error: {
      message,
      type: opts.type ?? errorTypeForStatus(status),
      param: opts.param ?? null,
      code: opts.code ?? null,
    },
  };
}

export type ChatParse =
  | { ok: true; model: string; request: CanonicalChatRequest }
  | { ok: false; status: number; message: string; param?: string | null; code?: string | null };

const KNOWN_ROLES: readonly string[] = ['system', 'developer', 'user', 'assistant', 'tool'];

/** Legacy function-calling API — superseded by `tools`; not translated. */
const LEGACY_TOOL_KEYS: readonly string[] = ['functions', 'function_call'];

function parseErr(message: string, param?: string | null, code?: string | null): ChatParse {
  return { ok: false, status: 400, message, param: param ?? null, code: code ?? null };
}

interface FoldedContent {
  text: string;
  images: CanonicalImage[];
}

function parseContentParts(parts: unknown, param: string): { val: FoldedContent } | { err: ChatParse } {
  let content = '';
  const images: CanonicalImage[] = [];
  for (const [j, raw] of (parts as unknown[]).entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { err: parseErr(`${param}[${j}] must be an object`, param) };
    }
    const part = raw as Record<string, unknown>;
    const type = part.type;
    if (type === 'text') {
      if (typeof part.text !== 'string') return { err: parseErr(`${param}[${j}].text must be a string`, param) };
      content += (content ? '\n' : '') + part.text;
    } else if (type === 'image_url' || type === 'input_image') {
      const img = imageOption(part.image_url, `${param}[${j}].image_url`);
      if (img.err) return { err: parseErr(img.err, param) };
      if (img.val) images.push(img.val);
    } else {
      return { err: parseErr(`Unsupported content part type '${String(type)}'`, param) };
    }
  }
  return { val: { text: content, images } };
}

/** Parses one openai `tool_calls[]` entry onto the canonical form. */
function parseToolCall(raw: unknown, param: string): { val: CanonicalToolCall } | { err: ChatParse } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { err: parseErr(`${param} must be an object`, param) };
  const tc = raw as Record<string, unknown>;
  if (tc.type !== undefined && tc.type !== 'function') {
    return { err: parseErr(`${param}.type must be 'function'`, param) };
  }
  if (typeof tc.id !== 'string' || !tc.id) return { err: parseErr(`${param}.id must be a string`, param) };
  const fn = tc.function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return { err: parseErr(`${param}.function must be an object`, param) };
  const f = fn as Record<string, unknown>;
  if (typeof f.name !== 'string' || !f.name) return { err: parseErr(`${param}.function.name must be a string`, param) };
  if (f.arguments !== undefined && f.arguments !== null && typeof f.arguments !== 'string') {
    return { err: parseErr(`${param}.function.arguments must be a JSON string`, param) };
  }
  return { val: { id: tc.id, name: f.name, arguments: typeof f.arguments === 'string' ? f.arguments : '' } };
}

/**
 * Parses + validates a POST /v1/chat/completions body into the canonical form.
 * M6: function tools, tool_choice, parallel_tool_calls, vision image parts and
 * tool/assistant tool_calls messages are translated; the legacy `functions`/
 * `function_call` API and vendor-hosted tool types are rejected explicitly.
 * Unknown top-level fields are preserved in `extras` for upstream passthrough.
 */
export async function parseOpenAiChatRequest(reader: { json: () => Promise<unknown> }): Promise<ChatParse> {
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

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return parseErr("Missing parameter: 'messages' must be a non-empty array", 'messages', 'missing_required_parameter');
  }
  for (const key of LEGACY_TOOL_KEYS) {
    if (key in raw) {
      return parseErr(`'${key}' (legacy function calling) is not supported — use the 'tools' parameter.`, key);
    }
  }

  const options: CanonicalChatOptions = {};
  const tools = toolDefsOption(raw.tools, 'openai');
  if (tools.err) return parseErr(tools.err, 'tools');
  options.tools = tools.val ?? null;
  const toolChoice = toolChoiceOption(raw.tool_choice, 'openai');
  if (toolChoice.err) return parseErr(toolChoice.err, 'tool_choice');
  options.toolChoice = toolChoice.val ?? null;
  const parallel = boolOption(raw.parallel_tool_calls, 'parallel_tool_calls');
  if (parallel.err) return parseErr(parallel.err, 'parallel_tool_calls');
  options.parallelToolCalls = parallel.val ?? null;

  const messages: CanonicalMessage[] = [];
  for (const [i, rawMsg] of raw.messages.entries()) {
    const param = `messages[${i}]`;
    if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) {
      return parseErr(`${param} must be an object`, param);
    }
    const msg = rawMsg as Record<string, unknown>;
    if (typeof msg.role !== 'string' || !KNOWN_ROLES.includes(msg.role)) {
      return parseErr(`${param}.role must be one of system, developer, user, assistant, tool`, `${param}.role`);
    }

    // Assistant tool invocations.
    let toolCalls: CanonicalToolCall[] | undefined;
    if (Array.isArray(msg.tool_calls)) {
      if (msg.role !== 'assistant') {
        return parseErr(`${param}.tool_calls is only valid on assistant messages`, `${param}.tool_calls`);
      }
      toolCalls = [];
      for (const [k, rawTc] of msg.tool_calls.entries()) {
        const tc = parseToolCall(rawTc, `${param}.tool_calls[${k}]`);
        if ('err' in tc) return tc.err;
        toolCalls.push(tc.val);
      }
    } else if ('tool_calls' in msg && msg.tool_calls !== null) {
      return parseErr(`${param}.tool_calls must be an array`, `${param}.tool_calls`);
    }
    if ('function_call' in msg) {
      return parseErr(`${param}.function_call (legacy function calling) is not supported — use tool_calls.`, `${param}`);
    }

    // Tool result message: bound to its tool call id; content may be null.
    if (msg.role === 'tool') {
      if (typeof msg.tool_call_id !== 'string' || !msg.tool_call_id) {
        return parseErr(`${param}.tool_call_id must be a string (the tool call this result answers)`, `${param}.tool_call_id`);
      }
      let content = '';
      const images: CanonicalImage[] = [];
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const folded = parseContentParts(msg.content, `${param}.content`);
        if ('err' in folded) return folded.err;
        content = folded.val.text;
        images.push(...folded.val.images);
      } else if (msg.content !== null && msg.content !== undefined) {
        return parseErr(`${param}.content must be a string, a content-part array or null`, `${param}.content`);
      }
      const { role, content: _c, tool_call_id: _tid, tool_calls: _tc, function_call: _fc, ...msgExtra } = msg;
      messages.push({ role: 'tool', content, toolCallId: msg.tool_call_id, ...(images.length ? { images } : {}), extra: msgExtra });
      continue;
    }

    const cv = msg.content;
    let content: string;
    const images: CanonicalImage[] = [];
    if (typeof cv === 'string') {
      content = cv;
    } else if (Array.isArray(cv) && cv.length > 0) {
      const folded = parseContentParts(cv, `${param}.content`);
      if ('err' in folded) return folded.err;
      content = folded.val.text;
      images.push(...folded.val.images);
    } else if ((cv === null || cv === undefined) && toolCalls) {
      content = ''; // assistant tool-call messages may carry no text
    } else {
      return parseErr(`${param}.content must be a string or a non-empty content-part array`, `${param}.content`);
    }

    const { role, content: _c, tool_calls: _tc, function_call: _fc, ...msgExtra } = msg;
    messages.push({
      role: role as CanonicalRole,
      content,
      ...(images.length ? { images } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      extra: msgExtra,
    });
  }

  let stream = false;
  if (raw.stream !== undefined) {
    if (typeof raw.stream !== 'boolean') return parseErr('stream must be a boolean', 'stream');
    stream = raw.stream;
  }

  // stream_options.include_usage → canonical (openai adapter re-emits it for
  // streaming requests; translated anthropic streams append a final usage-only
  // chunk). Only present when the client declared it; absent otherwise.
  let streamIncludeUsage: boolean | undefined;
  if (raw.stream_options !== undefined && raw.stream_options !== null) {
    if (!raw.stream_options || typeof raw.stream_options !== 'object' || Array.isArray(raw.stream_options)) {
      return parseErr('stream_options must be an object', 'stream_options');
    }
    const so = (raw.stream_options as Record<string, unknown>).include_usage;
    if (so !== undefined) {
      if (typeof so !== 'boolean') return parseErr('stream_options.include_usage must be a boolean', 'stream_options.include_usage');
      streamIncludeUsage = so;
    }
  }

  // M16 OpenRouter parity: `usage: {include: true}` asks for usage accounting
  // on streaming requests — same canonical slot as include_usage. Parsed out
  // so the object never rides extras to upstreams (they would 400 on it).
  if (raw.usage !== undefined && raw.usage !== null) {
    if (!raw.usage || typeof raw.usage !== 'object' || Array.isArray(raw.usage)) {
      return parseErr('usage must be an object', 'usage');
    }
    const include = (raw.usage as Record<string, unknown>).include;
    if (include !== undefined) {
      if (typeof include !== 'boolean') return parseErr('usage.include must be a boolean', 'usage.include');
      if (include) streamIncludeUsage = true;
    }
  }

  const temperature = floatOption(raw.temperature, 'temperature', 0, 2);
  if (temperature.err) return parseErr(temperature.err, 'temperature');
  options.temperature = temperature.val;

  const topP = floatOption(raw.top_p, 'top_p', 0, 1);
  if (topP.err) return parseErr(topP.err, 'top_p');
  options.topP = topP.val;

  const hasCompletion = raw.max_completion_tokens !== undefined;
  const maxTokens = intOption(
    hasCompletion ? raw.max_completion_tokens : raw.max_tokens,
    hasCompletion ? 'max_completion_tokens' : 'max_tokens',
    1,
    1_000_000_000,
  );
  if (maxTokens.err) return parseErr(maxTokens.err, hasCompletion ? 'max_completion_tokens' : 'max_tokens');
  options.maxTokens = maxTokens.val;
  if (maxTokens.val !== undefined && maxTokens.val !== null) {
    options.maxTokensField = hasCompletion ? 'max_completion_tokens' : 'max_tokens';
  }

  const stop = stopOption(raw.stop);
  if (stop.err) return parseErr(stop.err, 'stop');
  options.stop = stop.val ?? (raw.stop === undefined ? undefined : []);

  const n = intOption(raw.n, 'n', 1, 128);
  if (n.err) return parseErr(n.err, 'n');
  options.n = n.val;

  // Everything we did not consume above rides along untouched.
  const {
    model: _m, messages: _msgs, stream: _s, stream_options: _so, usage: _usage, temperature: _t, top_p: _tp, max_tokens: _mt, max_completion_tokens: _mct,
    stop: _st, n: _n, tools: _tools, tool_choice: _tch, parallel_tool_calls: _ptc, ...extras
  } = raw;

  return {
    ok: true,
    model,
    request: {
      messages,
      stream,
      ...(streamIncludeUsage !== undefined ? { streamIncludeUsage } : {}),
      options,
      extras,
    },
  };
}

/**
 * Maps anthropic-vocabulary error types onto openai ones; openai-native names
 * (and unknown types) pass through untouched.
 */
const ANTHROPIC_TO_OPENAI_TYPE: Record<string, string> = {
  not_found_error: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  overloaded_error: 'api_error',
  timeout_error: 'api_error',
  billing_error: 'permission_error',
};

function normalizeUpstreamErrorType(type: string): string {
  return ANTHROPIC_TO_OPENAI_TYPE[type] ?? type;
}

/**
 * Maps an upstream failure response into the OpenAI error envelope. Preserves
 * the upstream status, message and `code` so clients get actionable errors;
 * fills in `type` from the status when the upstream did not send one. Handles
 * openai-shaped, anthropic-shaped (`{"type":"error","error":{…}}`) and raw
 * text bodies.
 */
export function upstreamErrorToOpenAi(status: number, raw: string): OpenAiErrorBody {
  let message = '';
  let type: string | undefined;
  let param: string | null = null;
  let code: string | null = null;

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    const errVal = (parsed as { error?: unknown }).error;
    if (typeof errVal === 'string') {
      message = errVal;
    } else if (errVal && typeof errVal === 'object') {
      const e = errVal as { message?: unknown; type?: unknown; param?: unknown; code?: unknown };
      if (typeof e.message === 'string') message = e.message;
      else message = JSON.stringify(errVal).slice(0, 240);
      if (typeof e.type === 'string') type = normalizeUpstreamErrorType(e.type);
      if (typeof e.param === 'string') param = e.param;
      if (typeof e.code === 'string') code = e.code;
    } else if (typeof (parsed as { message?: unknown }).message === 'string') {
      message = (parsed as { message?: string }).message as string;
    } else {
      message = JSON.stringify(parsed).slice(0, 240);
    }
  } else {
    message = raw.slice(0, 240);
  }
  if (!message) message = `Upstream returned HTTP ${status}.`;
  return { error: { message, type: type ?? errorTypeForStatus(status), param, code } };
}

// ------------------------------------------------- anthropic → openai wire

/** Maps an anthropic stop_reason onto the openai finish_reason vocabulary. */
export function mapAnthropicStopReasonToFinish(stop: unknown): string | null {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return null;
  }
}

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** Safely stringifies a tool input object (anthropic `input`) to the openai arguments encoding. */
export function toolInputToArguments(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/**
 * Translates an anthropic Message JSON body into an openai chat.completion.
 * Text blocks fold into one message string; tool_use blocks become
 * `message.tool_calls` (arguments re-encoded as a JSON string). `model` is
 * the caller-facing model (the requested slug).
 */
export function anthropicMessageToOpenAiCompletion(
  payload: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const blocks = Array.isArray(payload.content) ? (payload.content as Record<string, unknown>[]) : [];
  let text = '';
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: toolInputToArguments(block.input) },
      });
    }
    // thinking / redacted_thinking blocks are not translated (explicit parse-time rejection inbound)
  }
  const message: Record<string, unknown> = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const promptTokens = toCount(usage.input_tokens);
  const completionTokens = toCount(usage.output_tokens);
  return {
    id: typeof payload.id === 'string' ? `chatcmpl-${payload.id}` : 'chatcmpl-khateway',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopReasonToFinish(payload.stop_reason),
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/** Options for the anthropic→openai SSE translator. */
export interface AnthropicToOpenAiStreamOptions {
  /**
   * Client asked for `stream_options.include_usage`: emit a spec-shaped final
   * usage-only chunk (`choices: []`) before `[DONE]` instead of riding usage
   * on the finish chunk (openai's own include_usage contract).
   */
  includeUsage?: boolean;
}

/**
 * Translates an anthropic Messages SSE stream into an openai
 * chat.completion.chunk stream (client-side dialect: openai). Emits the
 * role-first chunk, text deltas, one finish chunk (mapped stop reason;
 * usage rides on it unless includeUsage is set), then `data: [DONE]`.
 * Mid-stream anthropic `error` events become openai error data chunks.
 */
export function transformAnthropicSseToOpenAi(
  src: ReadableStream<Uint8Array>,
  model: string,
  opts: AnthropicToOpenAiStreamOptions = {},
): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    let started = false;
    let finished = false;
    let id = 'chatcmpl-khateway';
    let created = Math.floor(Date.now() / 1000);
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    // anthropic content-block index → openai tool_calls[] index (tool_use blocks only)
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;
    const includeUsage = opts.includeUsage === true;

    const chunk = (delta: Record<string, unknown>, finish: string | null, withUsage = false): string => {
      const body: Record<string, unknown> = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      if (withUsage) {
        body.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
      }
      return `data: ${JSON.stringify(body)}\n\n`;
    };

    const emitStart = () => {
      if (started) return;
      started = true;
      out.enqueue(chunk({ role: 'assistant', content: '' }, null));
    };

    const emitFinish = () => {
      if (finished) return;
      finished = true;
      out.enqueue(chunk({}, finishReason, !includeUsage));
      if (includeUsage) {
        // openai include_usage contract: a trailing chunk with an EMPTY
        // choices array carrying the aggregated usage.
        out.enqueue(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          })}\n\n`,
        );
      }
      out.enqueue('data: [DONE]\n\n');
    };

    return {
      onEvent(ev) {
        if (finished) return;
        if (ev.data === '[DONE]') {
          emitFinish();
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return; // skip malformed events
        }
        switch (payload.type) {
          case 'message_start': {
            const message = (payload.message ?? {}) as Record<string, unknown>;
            if (typeof message.id === 'string' && message.id) id = `chatcmpl-${message.id}`;
            created = Math.floor(Date.now() / 1000);
            const usage = (message.usage ?? {}) as Record<string, unknown>;
            promptTokens = toCount(usage.input_tokens);
            emitStart();
            break;
          }
          case 'content_block_start': {
            const block = (payload.content_block ?? {}) as Record<string, unknown>;
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
              const blockIndex = typeof payload.index === 'number' ? payload.index : toolIndexByBlock.size;
              const toolIndex = nextToolIndex++;
              toolIndexByBlock.set(blockIndex, toolIndex);
              emitStart();
              out.enqueue(
                chunk(
                  { tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] },
                  null,
                ),
              );
            }
            break;
          }
          case 'content_block_delta': {
            const delta = (payload.delta ?? {}) as Record<string, unknown>;
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              emitStart();
              out.enqueue(chunk({ content: delta.text }, null));
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
              const toolIndex = toolIndexByBlock.get(typeof payload.index === 'number' ? payload.index : -1);
              if (toolIndex !== undefined) {
                emitStart();
                out.enqueue(chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }, null));
              }
            }
            // thinking_delta arrives with the later reasoning work
            break;
          }
          case 'message_delta': {
            const delta = (payload.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.stop_reason === 'string') finishReason = mapAnthropicStopReasonToFinish(delta.stop_reason);
            const usage = (payload.usage ?? {}) as Record<string, unknown>;
            completionTokens = toCount(usage.output_tokens);
            break;
          }
          case 'message_stop': {
            emitStart();
            emitFinish();
            break;
          }
          case 'error': {
            const e = (payload.error ?? {}) as Record<string, unknown>;
            out.enqueue(
              `data: ${JSON.stringify(
                openAiError(
                  500,
                  typeof e.message === 'string' ? e.message : 'Upstream stream error.',
                  { type: typeof e.type === 'string' ? normalizeUpstreamErrorType(e.type) : undefined },
                ),
              )}\n\n`,
            );
            out.enqueue('data: [DONE]\n\n');
            finished = true;
            break;
          }
          // content_block_start(text)/stop and ping have no openai equivalent
        }
      },
      onEnd() {
        if (started) emitFinish();
      },
    };
  });
}
