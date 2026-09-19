// Usage extraction for request logging (M7). Wire-format parsing stays in
// dialects/ per the module boundaries: this module knows the UPSTREAM dialects'
// usage shapes — openai chat completions (`usage.prompt_tokens`/
// `completion_tokens`, JSON or SSE chunk), anthropic Messages
// (`usage.input_tokens` on message_start, `usage.output_tokens` on
// message_delta) and native Gemini (M12: `usageMetadata.promptTokenCount` /
// `candidatesTokenCount` + `thoughtsTokenCount`, JSON or SSE chunk — thinking
// tokens bill as output). The gateway tees upstream response bodies into
// watchUpstreamSseUsage so streamed requests still get token counts in
// request_logs without touching the client-facing stream.

export interface TokenUsage {
  tokensIn: number | null;
  tokensOut: number | null;
}

type Upstream = 'openai' | 'anthropic' | 'gemini';

function toInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Reads usage out of a non-stream upstream JSON body; null when absent. */
export function usageFromJsonBody(upstream: Upstream, payload: Record<string, unknown>): TokenUsage | null {
  if (upstream === 'gemini') {
    // Gemini keeps usage under `usageMetadata` (no `usage` key), with thinking
    // tokens reported separately — they bill as output, so fold them in.
    const u = payload.usageMetadata;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
    const m = u as Record<string, unknown>;
    const tokensIn = toInt(m.promptTokenCount);
    const tokensOut = toInt(m.candidatesTokenCount);
    const thoughts = toInt(m.thoughtsTokenCount);
    if (tokensIn === null && tokensOut === null && thoughts === null) return null;
    return { tokensIn, tokensOut: tokensOut === null && thoughts === null ? null : (tokensOut ?? 0) + (thoughts ?? 0) };
  }
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  if (upstream === 'anthropic') {
    const tokensIn = toInt(u.input_tokens);
    const tokensOut = toInt(u.output_tokens);
    if (tokensIn === null && tokensOut === null) return null;
    return { tokensIn, tokensOut };
  }
  const tokensIn = toInt(u.prompt_tokens);
  const tokensOut = toInt(u.completion_tokens);
  if (tokensIn === null && tokensOut === null) return null;
  return { tokensIn, tokensOut };
}

/**
 * Consumes an SSE byte stream (usually a tee()'d branch of the upstream body
 * that keeps flowing to the client untouched) and resolves with the last
 * usage seen on it, or null when the upstream never reported usage. Framing
 * mirrors dialects/sse.ts (event:/data: fields, blank-line separators, CRLF
 * or LF, `:`-prefixed keep-alives) but produces no output stream — this is a
 * pure consumer.
 */
export function watchUpstreamSseUsage(upstream: Upstream, src: ReadableStream<Uint8Array>): Promise<TokenUsage | null> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawUsage = false;
  const usage: { tokensIn: number | null; tokensOut: number | null } = { tokensIn: null, tokensOut: null };

  const handleData = (data: string): void => {
    if (data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    if (upstream === 'gemini') {
      // Each streamGenerateContent chunk may carry usageMetadata (the final
      // one always does) — the last value seen wins.
      const u = p.usageMetadata;
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        const m = u as Record<string, unknown>;
        const tokensIn = toInt(m.promptTokenCount);
        const tokensOut = toInt(m.candidatesTokenCount);
        const thoughts = toInt(m.thoughtsTokenCount);
        if (tokensIn !== null || tokensOut !== null || thoughts !== null) {
          usage.tokensIn = tokensIn;
          usage.tokensOut = tokensOut === null && thoughts === null ? null : (tokensOut ?? 0) + (thoughts ?? 0);
          sawUsage = true;
        }
      }
      return;
    }
    if (upstream === 'anthropic') {
      // message_start: message.usage.input_tokens; message_delta: usage.output_tokens.
      if (p.type === 'message_start' && p.message && typeof p.message === 'object') {
        const u = (p.message as Record<string, unknown>).usage;
        if (u && typeof u === 'object') {
          const v = toInt((u as Record<string, unknown>).input_tokens);
          if (v !== null) {
            usage.tokensIn = v;
            sawUsage = true;
          }
        }
      } else if (p.type === 'message_delta' && p.usage && typeof p.usage === 'object') {
        const v = toInt((p.usage as Record<string, unknown>).output_tokens);
        if (v !== null) {
          usage.tokensOut = v;
          sawUsage = true;
        }
      }
    } else {
      // openai: any chunk may carry usage (normally the final one, with
      // stream_options.include_usage; some vendors send it on every chunk).
      const u = p.usage;
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        const tokensIn = toInt((u as Record<string, unknown>).prompt_tokens);
        const tokensOut = toInt((u as Record<string, unknown>).completion_tokens);
        if (tokensIn !== null || tokensOut !== null) {
          usage.tokensIn = tokensIn;
          usage.tokensOut = tokensOut;
          sawUsage = true;
        }
      }
    }
  };

  const handleRawEvent = (rawEvent: string): void => {
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length > 0) handleData(dataLines.join('\n'));
  };

  return new Promise<TokenUsage | null>((resolve) => {
    const reader = src.getReader();
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            handleRawEvent(buffer.slice(0, sep));
            buffer = buffer.slice(sep + 2);
          }
        }
        if (buffer.trim()) handleRawEvent(buffer);
        resolve(sawUsage ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut } : null);
      } catch {
        // Client disconnected or upstream aborted mid-stream — report what we saw.
        resolve(sawUsage ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut } : null);
      }
    };
    void pump();
  });
}

/** Reads a (bounded) JSON body branch and extracts usage; null when unparseable. */
export async function watchUpstreamJsonUsage(upstream: Upstream, src: ReadableStream<Uint8Array>): Promise<TokenUsage | null> {
  const text = await new Response(src).text();
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return usageFromJsonBody(upstream, payload as Record<string, unknown>);
    }
  } catch {
    // non-JSON body — nothing to extract
  }
  return null;
}

/** Cost snapshot in USD; null when pricing or usage is unknown (null pricing ≠ free). */
export function costUsd(
  pricingInput: number | null,
  pricingOutput: number | null,
  usage: TokenUsage | null,
): number | null {
  if (!usage) return null;
  const { tokensIn, tokensOut } = usage;
  if (tokensIn === null && tokensOut === null) return null;
  if (pricingInput === null && pricingOutput === null) return null;
  let cost = 0;
  if (tokensIn !== null && pricingInput !== null) cost += (tokensIn / 1e6) * pricingInput;
  if (tokensOut !== null && pricingOutput !== null) cost += (tokensOut / 1e6) * pricingOutput;
  return Math.round(cost * 1e9) / 1e9; // keep 9 decimals; USD costs are tiny
}
