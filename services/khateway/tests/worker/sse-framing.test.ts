// Golden fixtures for the shared SSE framing (dialects/sse.ts): CRLF vs LF,
// keep-alive comments, multi-line data, trailing-event flush, and chunk
// boundaries that split events mid-field. Raw string comparison — no JSON
// parsing — this pins the envelope itself.
import { describe, expect, it } from 'vitest';
import { translateSseStream } from '../../src/worker/dialects/sse';
import { loadFixtures, sseSource } from './helpers';

interface RawEvent {
  event: string;
  data: string;
}

async function collect(src: ReadableStream<Uint8Array>): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  const out = translateSseStream(src, () => ({
    onEvent(ev) {
      events.push({ event: ev.event, data: ev.data });
    },
    onEnd() {
      // framing test doesn't assert end callbacks
    },
  }));
  await new Response(out).text(); // drain
  return events;
}

describe('sse framing (golden)', () => {
  for (const case_ of loadFixtures('sse-framing.json')) {
    it(case_.name as string, async () => {
      const src = sseSource(case_.input as string, case_.chunks as string[] | undefined);
      expect(await collect(src)).toEqual(case_.expected);
    });
  }
});
