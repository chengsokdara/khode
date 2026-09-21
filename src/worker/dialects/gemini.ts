// Native Gemini upstream dialect (M12): normalizes generateContent responses
// (JSON + SSE) onto OPENAI chat-completion shapes so the existing openai→
// anthropic / openai→responses translators (anthropicMessages.ts /
// openaiResponses.ts) serve the client faces unchanged. There is no gemini
// client dialect — every gemini pairing is translated, and the gateway feeds
// raw gemini payloads/streams through this module first (also on cache
// replays, which store the raw upstream payload).
//
// Usage math: usageMetadata.candidatesTokenCount EXCLUDES thinking, while
// totalTokenCount = prompt + thoughts + candidates (Google's documented
// semantics) — Khateway bills output as candidates + thoughts so thinking
// tokens are charged like any output token.
import type { OpenAiErrorBody } from './openaiChat';
import { errorTypeForStatus, openAiError } from './openaiChat';
import { translateSseStream } from './sse';

// ------------------------------------------------------------- usage math

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** Extracts the usageMetadata object from a gemini JSON payload or SSE chunk. */
export function geminiUsageMetadata(payload: Record<string, unknown>): Record<string, unknown> | null {
  const u = payload.usageMetadata;
  return u && typeof u === 'object' && !Array.isArray(u) ? (u as Record<string, unknown>) : null;
}

/** usageMetadata → {promptTokens, completionTokens} with thoughts folded into output. */
export function geminiTokensFromMetadata(u: Record<string, unknown>): { promptTokens: number; completionTokens: number } {
  const promptTokens = toCount(u.promptTokenCount);
  // candidatesTokenCount excludes thinking; output billing includes it.
  const completionTokens = toCount(u.candidatesTokenCount) + toCount(u.thoughtsTokenCount);
  return { promptTokens, completionTokens };
}

// ---------------------------------------------------------- error mapping

/** Google-status vocabulary → openai error types (unknown names derive from status). */
const GEMINI_STATUS_TO_OPENAI_TYPE: Record<string, string> = {
  INVALID_ARGUMENT: 'invalid_request_error',
  FAILED_PRECONDITION: 'invalid_request_error',
  OUT_OF_RANGE: 'invalid_request_error',
  UNAUTHENTICATED: 'authentication_error',
  PERMISSION_DENIED: 'permission_error',
  NOT_FOUND: 'not_found_error',
  RESOURCE_EXHAUSTED: 'rate_limit_error',
  ABORTED: 'api_error',
  INTERNAL: 'api_error',
  UNAVAILABLE: 'api_error',
  CANCELLED: 'api_error',
  DEADLINE_EXCEEDED: 'timeout_error',
};

/**
 * Maps a Gemini failure response (Google error envelope
 * `{"error":{"code":400,"message":"…","status":"INVALID_ARGUMENT"}}` or raw
 * text) into the OpenAI error envelope. The upstream HTTP status is
 * preserved; the gemini status string rides in `code` for debuggability.
 */
export function geminiErrorToOpenAi(status: number, raw: string): OpenAiErrorBody {
  let message = '';
  let type: string | undefined;
  let code: string | null = null;
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    const errVal = (parsed as { error?: unknown }).error;
    if (errVal && typeof errVal === 'object' && !Array.isArray(errVal)) {
      const e = errVal as Record<string, unknown>;
      if (typeof e.message === 'string') message = e.message;
      else message = JSON.stringify(errVal).slice(0, 240);
      if (typeof e.status === 'string' && e.status) {
        code = e.status;
        type = GEMINI_STATUS_TO_OPENAI_TYPE[e.status];
      }
    } else if (typeof (parsed as { message?: unknown }).message === 'string') {
      message = (parsed as { message: string }).message;
    } else {
      message = JSON.stringify(parsed).slice(0, 240);
    }
  } else {
    message = raw.slice(0, 240);
  }
  if (!message) message = `Upstream returned HTTP ${status}.`;
  return openAiError(status, message, { type: type ?? errorTypeForStatus(status), code });
}

// --------------------------------------------------- gemini → openai (JSON)

/**
 * Maps a Candidate.finishReason onto the openai finish_reason vocabulary.
 * Gemini has no dedicated tool-call finish reason (tool calls arrive under
 * STOP) — when the response carries functionCall parts the caller overrides
 * to 'tool_calls' (openai convention); MAX_TOKENS still wins ('length').
 */
export function mapGeminiFinishReason(finish: unknown, hasToolCalls = false): string {
  switch (finish) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    // STOP, LANGUAGE, OTHER, MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, …
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

/** One candidate's parts → openai text + reasoning + tool_calls (M17: thought
 * parts surface as `reasoning_content` — the DeepSeek/GLM convention this
 * gateway normalizes reasoning onto). */
function partsToOpenAiMessage(parts: unknown): { text: string; reasoning: string; toolCalls: Record<string, unknown>[] } {
  let text = '';
  let reasoning = '';
  const toolCalls: Record<string, unknown>[] = [];
  if (!Array.isArray(parts)) return { text, reasoning, toolCalls };
  for (const raw of parts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const part = raw as Record<string, unknown>;
    if (part.thought === true) {
      if (typeof part.text === 'string' && part.text) reasoning += (reasoning ? '\n' : '') + part.text;
      continue;
    }
    if (typeof part.text === 'string' && part.text) {
      text += (text ? '\n' : '') + part.text;
    } else if (part.functionCall && typeof part.functionCall === 'object') {
      const fc = part.functionCall as Record<string, unknown>;
      if (typeof fc.name === 'string' && fc.name) {
        const index = toolCalls.length;
        let args = '';
        try {
          args = JSON.stringify(fc.args ?? {}) ?? '';
        } catch {
          args = '';
        }
        toolCalls.push({
          id: `call_gemini_${index}`,
          type: 'function',
          function: { name: fc.name, arguments: args },
        });
      }
    }
    // inlineData / fileData / executableCode parts have no openai equivalent here
  }
  return { text, reasoning, toolCalls };
}

/**
 * Normalizes a Gemini generateContent JSON body into an openai chat.completion
 * (the first candidate; multi-candidate responses are not requested — n>1 is
 * rejected at request build time). `model` is the caller-facing model (the
 * requested slug).
 */
export function geminiCompletionToOpenAi(payload: Record<string, unknown>, model: string): Record<string, unknown> {
  const candidates = Array.isArray(payload.candidates) ? (payload.candidates as Record<string, unknown>[]) : [];
  const candidate = candidates[0] ?? {};
  const content = candidate.content;
  const parts = content && typeof content === 'object' && !Array.isArray(content) ? (content as Record<string, unknown>).parts : null;
  const { text, reasoning, toolCalls } = partsToOpenAiMessage(parts);
  const message: Record<string, unknown> = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = geminiUsageMetadata(payload);
  const { promptTokens, completionTokens } = usage
    ? geminiTokensFromMetadata(usage)
    : { promptTokens: 0, completionTokens: 0 };
  return {
    id: typeof payload.responseId === 'string' && payload.responseId ? `chatcmpl-${payload.responseId}` : 'chatcmpl-khateway',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapGeminiFinishReason(candidate.finishReason, toolCalls.length > 0),
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

// ---------------------------------------------------- gemini → openai (SSE)

/** Options for the gemini→openai SSE normalizer. */
export interface GeminiToOpenAiStreamOptions {
  /**
   * Client asked for `stream_options.include_usage`: emit a spec-shaped final
   * usage-only chunk (`choices: []`) before `[DONE]` instead of riding usage
   * on the finish chunk (openai's include_usage contract).
   */
  includeUsage?: boolean;
}

/**
 * Normalizes a Gemini streamGenerateContent (alt=sse) stream into an openai
 * chat.completion.chunk stream. Each upstream `data:` event is one
 * GenerateContentResponse; text parts stream as content deltas, functionCall
 * parts as full-arguments tool_call deltas, and the finishReason /
 * usageMetadata event closes the stream (`data: [DONE]`). Malformed events
 * are skipped; a stream that ends without a finishReason still emits the
 * finish chunk so downstream translators always see a closed stream.
 */
export function transformGeminiSseToOpenAi(
  src: ReadableStream<Uint8Array>,
  model: string,
  opts: GeminiToOpenAiStreamOptions = {},
): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    let started = false;
    let finished = false;
    let id = 'chatcmpl-khateway';
    const created = Math.floor(Date.now() / 1000);
    let finishReasonRaw: string | null = null;
    let sawToolCall = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let toolCallCount = 0;
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
      emitStart();
      const finish = finishReasonRaw
        ? mapGeminiFinishReason(finishReasonRaw, sawToolCall)
        : sawToolCall
          ? 'tool_calls'
          : 'stop';
      out.enqueue(chunk({}, finish, !includeUsage));
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
        if (payload.error && typeof payload.error === 'object') {
          const e = payload.error as Record<string, unknown>;
          out.enqueue(
            `data: ${JSON.stringify(
              openAiError(
                500,
                typeof e.message === 'string' ? e.message : 'Upstream stream error.',
                { type: typeof e.status === 'string' ? GEMINI_STATUS_TO_OPENAI_TYPE[e.status] ?? 'api_error' : undefined },
              ),
            )}\n\n`,
          );
          out.enqueue('data: [DONE]\n\n');
          finished = true;
          return;
        }
        if (typeof payload.responseId === 'string' && payload.responseId) id = `chatcmpl-${payload.responseId}`;
        const usage = geminiUsageMetadata(payload);
        if (usage) {
          const t = geminiTokensFromMetadata(usage);
          promptTokens = t.promptTokens;
          completionTokens = t.completionTokens;
        }
        const candidates = Array.isArray(payload.candidates) ? (payload.candidates as Record<string, unknown>[]) : [];
        const candidate = candidates[0];
        if (candidate) {
          if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
            finishReasonRaw = candidate.finishReason;
          }
          const content = candidate.content;
          const parts = content && typeof content === 'object' && !Array.isArray(content) ? (content as Record<string, unknown>).parts : null;
          if (Array.isArray(parts)) {
            let textBuffer = '';
            let thoughtBuffer = '';
            for (const raw of parts) {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
              const part = raw as Record<string, unknown>;
              if (part.thought === true) {
                // M17: thought summaries surface as reasoning_content deltas.
                if (typeof part.text === 'string' && part.text) thoughtBuffer += (thoughtBuffer ? '\n' : '') + part.text;
                continue;
              }
              if (typeof part.text === 'string' && part.text) textBuffer += (textBuffer ? '\n' : '') + part.text;
              if (part.functionCall && typeof part.functionCall === 'object') {
                const fc = part.functionCall as Record<string, unknown>;
                if (typeof fc.name === 'string' && fc.name) {
                  sawToolCall = true;
                  const index = toolCallCount++;
                  let args = '';
                  try {
                    args = JSON.stringify(fc.args ?? {}) ?? '';
                  } catch {
                    args = '';
                  }
                  emitStart();
                  out.enqueue(
                    chunk(
                      { tool_calls: [{ index, id: `call_gemini_${index}`, type: 'function', function: { name: fc.name, arguments: args } }] },
                      null,
                    ),
                  );
                }
              }
            }
            if (thoughtBuffer) {
              emitStart();
              out.enqueue(chunk({ reasoning_content: thoughtBuffer }, null));
            }
            if (textBuffer) {
              emitStart();
              out.enqueue(chunk({ content: textBuffer }, null));
            }
          }
        } else if (!started && !finishReasonRaw) {
          // No candidates at all — a blocked prompt (promptFeedback.blockReason).
          const feedback = payload.promptFeedback;
          if (feedback && typeof feedback === 'object' && (feedback as Record<string, unknown>).blockReason) {
            finishReasonRaw = 'SAFETY';
          }
        }
      },
      onEnd() {
        emitFinish();
      },
    };
  });
}

// ------------------------------------------------------- embeddings (M13)

/** The OpenAI /v1/embeddings response body Khateway serves to clients. */
export interface OpenAiEmbeddingsResponseBody {
  object: 'list';
  data: { object: 'embedding'; index: number; embedding: number[] | string }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * Packs floats as little-endian float32 and base64-encodes them — the openai
 * `encoding_format: 'base64'` embedding representation. Needed when a base64
 * client asks a Gemini upstream, whose embeddings are always float arrays.
 */
export function floatsToBase64(values: number[]): string {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Normalizes a Gemini embedContent / batchEmbedContents response onto the
 * OpenAI embeddings shape (`data[]` in input order — Google preserves batch
 * order). `encodingFormat: 'base64'` converts the float arrays client-side;
 * float (the default) passes values through. usageMetadata.promptTokenCount
 * (verified present on both embeddings endpoints) maps onto the openai usage
 * object — embeddings have no output tokens.
 */
export function geminiEmbeddingsToOpenAi(
  payload: Record<string, unknown>,
  model: string,
  encodingFormat?: 'float' | 'base64' | null,
): OpenAiEmbeddingsResponseBody {
  const rawList: unknown[] = Array.isArray(payload.embeddings)
    ? (payload.embeddings as unknown[])
    : payload.embedding && typeof payload.embedding === 'object'
      ? [payload.embedding]
      : [];
  const data = rawList.map((raw, index): OpenAiEmbeddingsResponseBody['data'][number] => {
    const values =
      raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).values)
        ? ((raw as Record<string, unknown>).values as number[])
        : [];
    return {
      object: 'embedding',
      index,
      embedding: encodingFormat === 'base64' ? floatsToBase64(values) : values,
    };
  });
  const out: OpenAiEmbeddingsResponseBody = { object: 'list', data, model };
  const usage = geminiUsageMetadata(payload);
  if (usage) {
    const tokens = toCount(usage.promptTokenCount);
    out.usage = { prompt_tokens: tokens, total_tokens: tokens };
  }
  return out;
}
