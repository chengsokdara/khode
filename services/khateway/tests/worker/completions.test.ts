// Legacy text-completions face (M16): parse goldens for the prompt → canonical
// mapping, JSON chat-completion → text_completion rewriting, and SSE chunk
// rewriting. The keep-alive injector gets inline timing cases (real timers,
// short intervals) — it is a stream wrapper, not a wire format.
import { describe, expect, it } from 'vitest';
import {
  completionFromChatCompletion,
  parseOpenAiCompletionsRequest,
  transformChatSseToTextCompletionSse,
} from '../../src/worker/dialects/openaiCompletions';
import { withSseKeepAlive } from '../../src/worker/dialects/sse';
import { loadFixtures, parseSse, readerOf, sseSource, streamText } from './helpers';

describe('openai completions (golden)', () => {
  for (const case_ of loadFixtures('openai-completions.json')) {
    const name = case_.name as string;
    if (name.startsWith('parse:')) {
      it(name, async () => {
        expect(await parseOpenAiCompletionsRequest(readerOf(case_))).toEqual(case_.expected);
      });
    } else if (name.startsWith('json:')) {
      it(name, () => {
        expect(completionFromChatCompletion(case_.payload, case_.fallbackModel as string)).toEqual(case_.expected);
      });
    } else if (name.startsWith('sse:')) {
      it(name, async () => {
        const out = transformChatSseToTextCompletionSse(sseSource(case_.input as string), case_.fallbackModel as string);
        expect(parseSse(await streamText(out))).toEqual(case_.expected);
      });
    }
  }
});

describe('withSseKeepAlive', () => {
  it('injects a keep-alive comment while the upstream is silent', async () => {
    const src = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        await new Promise((r) => setTimeout(r, 80));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const text = await streamText(withSseKeepAlive(src, 20));
    const commentAt = text.indexOf(': keep-alive');
    expect(commentAt).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('data: [DONE]')).toBeGreaterThan(commentAt);
  });

  it('never injects when the upstream keeps flowing', async () => {
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: one\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const text = await streamText(withSseKeepAlive(src, 60_000));
    expect(text).not.toContain(': keep-alive');
  });
});
