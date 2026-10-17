// Legacy OpenAI text-completions client face (M16): POST /v1/completions,
// the API generations of tools still speak. The prompt is parsed onto the
// canonical chat form (prompt → user message; the model continues it) so the
// face rides the FULL chat pipeline — routing, gates, fallbacks, cache,
// logging, debits — and every upstream adapter (openai-compatible, anthropic,
// native Gemini) serves it through the existing cells.
//
// Responses are REWRITTEN (never relayed): a chat-completion JSON or chunk
// stream becomes `text_completion` shape (choices[].text instead of
// message/delta content). Same-dialect openai upstreams therefore do not take
// the byte-identical passthrough path on this face — the translation is the
// point. Prompt arrays (n>1 semantics) and the legacy extras (echo, suffix,
// best_of, logprobs) are rejected explicitly rather than silently mis-shaped.
// Unknown request fields are DROPPED (the legacy face has no extras surface).
import type { CanonicalChatOptions, CanonicalChatRequest, CanonicalMessage } from '../canonical';
import { floatOption, intOption, stopOption, boolOption } from './options';
import { translateSseStream } from './sse';

export type CompletionsParse =
  | { ok: true; model: string; request: CanonicalChatRequest }
  | { ok: false; status: number; message: string; param?: string | null; code?: string | null };

function parseErr(message: string, param?: string | null, code?: string | null): CompletionsParse {
  return { ok: false, status: 400, message, param: param ?? null, code: code ?? null };
}

/** Legacy params Khateway cannot express on the text face — explicit 400, not a silent drop. */
const UNSUPPORTED_PARAMS: readonly string[] = ['echo', 'suffix', 'best_of', 'logprobs', 'logit_bias'];

function parseContent(value: unknown): string {
  if (typeof value === 'string') return value;
  // Defensive: content-parts arrays fold their text parts (same rule as the
  // openai→anthropic fold).
  if (Array.isArray(value)) {
    return value
      .filter((p): p is { type: string; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return '';
}

/** finish_reason mapping chat → legacy: tool calls cannot exist on the text face. */
function mapFinishReason(reason: unknown): string | null {
  if (reason === 'length' || reason === 'content_filter') return reason;
  if (typeof reason === 'string' && reason) return 'stop';
  return null;
}

export async function parseOpenAiCompletionsRequest(reader: { json: () => Promise<unknown> }): Promise<CompletionsParse> {
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

  if (typeof raw.prompt !== 'string') {
    if (Array.isArray(raw.prompt)) {
      return parseErr(
        'prompt arrays (n>1 semantics) are not supported on /v1/completions — send one prompt per request.',
        'prompt',
      );
    }
    return parseErr("Missing parameter: 'prompt' must be a string", 'prompt', 'missing_required_parameter');
  }
  const prompt = raw.prompt;

  for (const key of UNSUPPORTED_PARAMS) {
    if (key in raw) {
      return parseErr(`'${key}' is not supported on /v1/completions.`, key);
    }
  }

  const options: CanonicalChatOptions = {};
  if (raw.max_tokens !== undefined) {
    const max = intOption(raw.max_tokens, 'max_tokens', 1, 200_000);
    if (max.err) return parseErr(max.err, 'max_tokens');
    options.maxTokens = max.val;
    options.maxTokensField = 'max_tokens';
  }
  if (raw.temperature !== undefined) {
    const t = floatOption(raw.temperature, 'temperature', 0, 2);
    if (t.err) return parseErr(t.err, 'temperature');
    options.temperature = t.val;
  }
  if (raw.top_p !== undefined) {
    const p = floatOption(raw.top_p, 'top_p', 0, 1);
    if (p.err) return parseErr(p.err, 'top_p');
    options.topP = p.val;
  }
  if (raw.stop !== undefined) {
    const stop = stopOption(raw.stop, 4);
    if (stop.err) return parseErr(stop.err, 'stop');
    options.stop = stop.val;
  }
  const stream = boolOption(raw.stream ?? false, 'stream');
  if (stream.err) return parseErr(stream.err, 'stream');
  if (raw.n !== undefined && raw.n !== 1) {
    return parseErr('n > 1 is not supported on /v1/completions — send one prompt per request.', 'n');
  }

  // Legacy-native penalties ride extras (openai upstreams accept them; the
  // anthropic/gemini adapters drop extras deliberately).
  const extras: Record<string, unknown> = {};
  if (raw.presence_penalty !== undefined) extras.presence_penalty = raw.presence_penalty;
  if (raw.frequency_penalty !== undefined) extras.frequency_penalty = raw.frequency_penalty;

  const messages: CanonicalMessage[] = [{ role: 'user', content: prompt, extra: {} }];
  const request: CanonicalChatRequest = {
    messages,
    stream: stream.val === true,
    options,
    extras,
  };
  return { ok: true, model, request };
}

/**
 * Rewrites a chat-completion JSON payload into legacy `text_completion`
 * shape. Returns null when the payload is not a readable chat completion.
 */
export function completionFromChatCompletion(
  payload: unknown,
  fallbackModel: string,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.choices)) return null;
  const choices = p.choices.map((rawCh, i) => {
    const ch = (rawCh && typeof rawCh === 'object' ? rawCh : {}) as Record<string, unknown>;
    const message = (ch.message && typeof ch.message === 'object' ? ch.message : {}) as Record<string, unknown>;
    return {
      index: typeof ch.index === 'number' ? ch.index : i,
      text: parseContent(message.content),
      finish_reason: mapFinishReason(ch.finish_reason),
      logprobs: null,
    };
  });
  return {
    id: typeof p.id === 'string' ? p.id : 'text-completion',
    object: 'text_completion',
    created: typeof p.created === 'number' ? p.created : Math.floor(Date.now() / 1000),
    model: typeof p.model === 'string' && p.model ? p.model : fallbackModel,
    choices,
    ...(p.usage != null ? { usage: p.usage } : {}),
  };
}

/**
 * Rewrites an openai chat-completion SSE stream into legacy text_completion
 * chunks (`choices[].text` deltas). Usage-only chunks (choices: []) pass
 * through verbatim; a missing [DONE] is synthesized on end (mirrors the
 * other openai SSE translators' close contract).
 */
export function transformChatSseToTextCompletionSse(
  src: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  return translateSseStream(src, (out) => {
    let syntheticId: string | null = null;
    let doneSent = false;
    const chunkId = (raw: Record<string, unknown>): string => {
      if (typeof raw.id === 'string' && raw.id) return raw.id;
      if (syntheticId === null) syntheticId = `text-completion-${fallbackModel}`;
      return syntheticId;
    };
    return {
      onEvent(ev) {
        if (ev.data === '[DONE]') {
          doneSent = true;
          out.enqueue('data: [DONE]\n\n');
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(ev.data);
        } catch {
          return; // skip malformed events — same stance as the other translators
        }
        if (!raw || typeof raw !== 'object') return;
        const chunk = raw as Record<string, unknown>;
        const created = typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000);
        const model = typeof chunk.model === 'string' && chunk.model ? chunk.model : fallbackModel;
        const usage = chunk.usage != null && typeof chunk.usage === 'object' ? chunk.usage : null;
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const outChoices = choices.map((rawCh, i) => {
          const ch = (rawCh && typeof rawCh === 'object' ? rawCh : {}) as Record<string, unknown>;
          const delta = (ch.delta && typeof ch.delta === 'object' ? ch.delta : {}) as Record<string, unknown>;
          return {
            index: typeof ch.index === 'number' ? ch.index : i,
            text: typeof delta.content === 'string' ? delta.content : '',
            finish_reason: mapFinishReason(ch.finish_reason),
            logprobs: null,
          };
        });
        const body: Record<string, unknown> = {
          id: chunkId(chunk),
          object: 'text_completion',
          created,
          model,
          choices: outChoices,
        };
        if (usage) body.usage = usage;
        out.enqueue(`data: ${JSON.stringify(body)}\n\n`);
      },
      onEnd() {
        // Synthesize the terminator only when the upstream never sent one —
        // a double [DONE] breaks strict SSE consumers.
        if (!doneSent) out.enqueue('data: [DONE]\n\n');
      },
    };
  });
}
