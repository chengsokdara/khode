// Generic text/event-stream framing shared by the dialect SSE translators:
// consumes an upstream byte stream, hands well-formed SSE events to the
// caller, and carries translated output bytes back to the client. Dialect-
// specific chunk/event formats live in dialects/openaiChat.ts (OpenAI chat
// chunks + `[DONE]`) and dialects/anthropicMessages.ts (Messages events) —
// this module only knows the envelope (`event:`/`data:` fields, blank-line
// separators, `:comment` keep-alives, CRLF or LF line endings).

export interface SseEvent {
  /** `event:` field value; '' when the producer did not name the event. */
  event: string;
  /** `data:` payload with lines joined by '\n'; sentinels like `[DONE]` pass through verbatim. */
  data: string;
}

export interface SseTranslateHandlers {
  onEvent(ev: SseEvent): void;
  /** The upstream stream ended (with or without a terminator event). */
  onEnd(): void;
}

export interface SseOut {
  /** Queues translated UTF-8 text for the client. */
  enqueue(text: string): void;
}

/**
 * Pipes `src` through an SSE parser: every parsed event goes to
 * `handlers.onEvent`, whose enqueue calls become the returned stream's bytes;
 * `handlers.onEnd` runs after the last event (or on flush of a trailing
 * unterminated event). Malformed individual events are skipped by the caller;
 * framing itself is lenient (that is the robust relay behavior).
 */
export function translateSseStream(
  src: ReadableStream<Uint8Array>,
  makeHandlers: (out: SseOut) => SseTranslateHandlers,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let handlers: SseTranslateHandlers | null = null;

  const dispatch = (rawEvent: string): void => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue; // keep-alive comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return; // no payload → nothing translatable
    handlers?.onEvent({ event, data: dataLines.join('\n') });
  };

  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        handlers = makeHandlers({
          enqueue: (text) => controller.enqueue(encoder.encode(text)),
        });
      },
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          dispatch(rawEvent);
        }
      },
      flush() {
        if (buffer.trim()) dispatch(buffer);
        handlers?.onEnd();
      },
    }),
  );
}

const SSE_KEEP_ALIVE = new TextEncoder().encode(': keep-alive\n\n');

/**
 * M16: injects `: keep-alive` comment lines into an SSE stream during
 * silence, so slow upstreams don't look dead to clients/intermediaries
 * (OpenRouter does the same). The timer races the next upstream chunk; when
 * it wins, a comment is enqueued and the wait continues — comments are
 * ignored by every SSE consumer and stripped by translateSseStream's parser.
 * Backpressure-friendly: upstream is only read when the client pulls.
 */
export function withSseKeepAlive(src: ReadableStream<Uint8Array>, intervalMs = 15_000): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          const timer = setTimeout(() => controller.enqueue(SSE_KEEP_ALIVE), intervalMs);
          try {
            chunk = await reader.read();
          } finally {
            clearTimeout(timer);
          }
          if (chunk.done) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
          return;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}
