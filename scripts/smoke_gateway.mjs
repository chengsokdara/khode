// Gateway (/v1) smoke test against `wrangler dev` on :8787 — needs
// `npm run dev` running first. Spins up a local mock upstream on 127.0.0.1
// (ephemeral port, speaking BOTH the openai and anthropic dialects),
// admin-creates fixtures pointing at it, exercises the whole pipeline
// (routing, pinning, non-stream + SSE, error mapping, the cross-dialect
// matrix in all client×upstream cells, the /v1/responses third client
// dialect, the M6 tools/vision translation matrix and fallback-chain
// retries, the M12 native-gemini matrix and the M13 /v1/embeddings branch)
// and deletes its fixtures afterwards.
//
// Usage: node scripts/smoke_gateway.mjs
import http from 'node:http';

const base = 'http://127.0.0.1:8787';
let failures = 0;
const passes = [];
let apiKey = ''; // smoke client key — created after login, used on every /v1 call

const v1Headers = () => ({
  'content-type': 'application/json',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});
const fail = (name, detail = '') => {
  failures += 1;
  console.log(`FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
};
const pass = (name, detail = '') => {
  passes.push(name);
  console.log(`PASS — ${name}${detail ? ` [${detail}]` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? pass(name, detail) : fail(name, detail));

// ---------------------------------------------------------------- helpers

let cookie = '';
const j = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const sc = res.headers.get('set-cookie');
  if (sc && sc.includes('khateway_session=') && !sc.includes('Max-Age=0')) {
    cookie = sc.split(';')[0];
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, headers: res.headers, body };
};

const PROVIDER_NAMES = ['Khateway Mock (smoke)', 'Anthropic Mock (smoke)', 'Dual Mock (smoke)', 'Dual Mock Bare (smoke)', 'Gemini Mock (smoke)'];
const SLUGS = [
  'mock-chat', 'mock-chat-429', 'mock-chat-401', 'mock-chat-500', 'mock-chat-500t', 'mock-claude', 'mock-claude-429',
  'mock-tools', 'mock-claude-tools',
  'mock-dual', 'mock-dual-n', 'mock-dual-first-assistant', 'mock-dual-bare',
  'mock-fb-500', 'mock-fb-429', 'mock-fb-anthropic', 'mock-fb-dead', 'mock-fb-401',
  'mock-log-json', 'mock-log-stream',
  'mock-gemini', 'mock-gemini-tools', 'mock-gemini-400', 'mock-gemini-429',
  'mock-emb', 'mock-emb-fb', 'mock-emb-anthropic', 'mock-gem-emb',
];
const KEY_NAMES = ['Smoke Key (smoke)', 'Restricted (smoke)', 'Capped (smoke)'];

async function cleanup() {
  const providers = await j('/admin/providers');
  for (const p of providers.body ?? []) {
    if (PROVIDER_NAMES.includes(p.name)) await j(`/admin/providers/${p.id}`, { method: 'DELETE' });
  }
  const models = await j('/admin/models');
  for (const m of models.body ?? []) {
    if (SLUGS.includes(m.slug)) await j(`/admin/models/${m.id}`, { method: 'DELETE' });
  }
  const keys = await j('/admin/api-keys');
  for (const k of keys.body ?? []) {
    if (KEY_NAMES.includes(k.name)) await j(`/admin/api-keys/${k.id}`, { method: 'DELETE' });
  }
}

// --------------------------------------------------- mock openai upstream
// One mock server serves BOTH adapters: openai paths under /v1/chat/completions
// (provider base_url ends in /v1) and anthropic paths under /v1/messages
// (anthropic provider base_url is the bare origin — the adapter appends /v1).
// `lastReq` captures the most recent upstream request so tests can assert how
// Khateway translated auth headers, system positioning, max_tokens, etc.

const lastReq = { path: '', headers: {}, body: {} };

function startMockUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const url = req.url ?? '';
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) || {};
      } catch {
        body = {};
      }
      lastReq.path = url;
      lastReq.headers = req.headers;
      lastReq.body = body;
      const model = String(body.model ?? '');
      // GET /models listings (admin test-connection + fetch-models discovery).
      // The gemini native listing (/v1beta/models) is matched FIRST — it also
      // ends in /models but has a completely different body shape.
      if (url.endsWith('/v1beta/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            models: [
              { name: 'models/gemini-mock', displayName: 'Gemini Mock', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
              { name: 'models/gemini-embedding', displayName: 'Embedder', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
        );
      }
      if (url.endsWith('/models') && (req.method === 'GET' || !lastReq.body || Object.keys(lastReq.body).length === 0)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock', object: 'model' },
              { id: 'mock-chat', object: 'model', context_window: 128000 },
              { id: 'mock-chat-stream', object: 'model', display_name: 'Mock Chat (stream)' },
              { id: 'bad/slug+id', object: 'model' }, // exercise slug filtering on import
            ],
          }),
        );
      }
      if (url.endsWith('/v1/messages')) {
        // ---- anthropic Messages dialect mock ----
        if (model === 'claude-429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }));
        }
        if (model === 'claude-tools') {
          // Tool-calling response: text + tool_use block (arguments as an object).
          const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } };
          if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`);
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Calling tool' } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: toolUse })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"Paris"}' } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              id: 'msg_mock',
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: 'Calling tool' }, toolUse],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 7, output_tokens: 5 },
            }),
          );
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`);
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from the mock' } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' anthropic stream!' } })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 11 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: 'Hello from the mock upstream!' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 5 },
          }),
        );
      }
      // ---- native Gemini dialect (M12): /v1beta/models/{model}:generateContent
      const gemMatch = url.match(/\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents)/);
      if (gemMatch) {
        const gemModel = decodeURIComponent(gemMatch[1]);
        const isStream = gemMatch[2] === 'streamGenerateContent';
        // ---- native Gemini embeddings (M13): :embedContent / :batchEmbedContents
        if (gemMatch[2] === 'embedContent' || gemMatch[2] === 'batchEmbedContents') {
          const texts =
            gemMatch[2] === 'embedContent'
              ? [body.content?.parts?.[0]?.text ?? '']
              : (body.requests ?? []).map((r) => r.content?.parts?.[0]?.text ?? '');
          const tokens = 3 * texts.length;
          const emb = { values: [0.125, -0.25, 0.375] };
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify(
              gemMatch[2] === 'embedContent'
                ? { embedding: emb, usageMetadata: { promptTokenCount: tokens } }
                : { embeddings: texts.map(() => emb), usageMetadata: { promptTokenCount: tokens } },
            ),
          );
        }
        if (gemModel === 'gemini-400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: 400, message: 'Invalid argument for testing.', status: 'INVALID_ARGUMENT' } }));
        }
        if (gemModel === 'gemini-429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: 429, message: 'Resource exhausted.', status: 'RESOURCE_EXHAUSTED' } }));
        }
        const gemUsage = { promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 2, totalTokenCount: 12 };
        if (isStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const gemEvent = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
          if (gemModel === 'gemini-tool') {
            res.write(gemEvent({ responseId: 'gem-resp-1', candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, index: 0 }] }));
          } else {
            res.write(gemEvent({ responseId: 'gem-resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from native' }] }, index: 0 }] }));
            res.write(gemEvent({ responseId: 'gem-resp-1', candidates: [{ content: { role: 'model', parts: [{ text: ' Gemini!' }] }, index: 0 }] }));
          }
          res.write(gemEvent({ responseId: 'gem-resp-1', candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: gemUsage, modelVersion: 'gemini-mock' }));
          return res.end();
        }
        const gemParts =
          gemModel === 'gemini-tool' ? [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] : [{ text: 'Hello from native Gemini!' }];
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            responseId: 'gem-resp-1',
            modelVersion: 'gemini-mock',
            candidates: [{ content: { role: 'model', parts: gemParts }, finishReason: 'STOP', index: 0 }],
            usageMetadata: gemUsage,
          }),
        );
      }
      // ---- openai Embeddings dialect (M13): /v1/embeddings upstream face ----
      // Deterministic: each input costs 3 prompt tokens; embeddings are
      // 3-element float arrays (mock-emb-429 exercises the retryable path).
      if (url.endsWith('/embeddings')) {
        if (model === 'mock-emb-429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Slow down' } }));
        }
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const promptTokens = 3 * inputs.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_, i) => ({ object: 'embedding', index: i, embedding: [0.1 * (i + 1), 0.2, 0.3] })),
            model,
            usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          }),
        );
      }
      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `mock upstream: no such path ${url}` } }));
      }
      if (model === 'mock-429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Slow down' } })); // no type → gateway derives rate_limit_error
      }
      if (model === 'mock-401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ error: { message: 'Invalid mock API key', type: 'invalid_request_error', code: 'invalid_api_key' } }),
        );
      }
      if (model === 'mock-500-text') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('boom'); // non-JSON upstream error path
      }
      if (model === 'mock-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Mock upstream exploded' } })); // no type → api_error
      }
      if (model === 'mock-tools') {
        // Tool-calling response: assistant tool_calls with JSON-string arguments.
        const toolCall = { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const tchunk = (tc, finish) =>
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              created: 1,
              model,
              choices: [{ index: 0, delta: tc ? { tool_calls: [tc] } : {}, finish_reason: finish }],
            })}\n\n`;
          res.write(tchunk({ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }, null));
          res.write(tchunk({ index: 0, function: { arguments: '{"city"' } }, null));
          res.write(tchunk({ index: 0, function: { arguments: ':"Paris"}' } }, null));
          res.write(tchunk(null, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
          }),
        );
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish, usage) => {
          const payload = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          };
          if (usage) payload.usage = usage;
          return `data: ${JSON.stringify(payload)}\n\n`;
        };
        // stream_options.include_usage honored: a final usage-only chunk with
        // an empty choices array (openai's real contract).
        const withUsage = body.stream_options?.include_usage === true;
        res.write(chunk({ role: 'assistant', content: '' }, null));
        res.write(chunk({ content: 'Hello from the mock' }, null));
        res.write(chunk({ content: ' stream!' }, null));
        res.write(chunk({}, 'stop'));
        if (withUsage) {
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the mock upstream!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ------------------------------------------------------------------- run

const mock = await startMockUpstream();

(async () => {
  const login = await j('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'khateway-admin' }) });
  if (login.status !== 200) {
    fail('admin login (is `npm run dev` running on :8787?)', `status=${login.status}`);
    process.exitCode = 1;
    return;
  }

  await cleanup(); // in case an earlier failed run left fixtures behind

  // M10 rate limiting is ON by default — this suite bursts hundreds of
  // anonymous/keyed requests per minute from one dev IP, so disable it here
  // (smoke_m10.mjs is the suite that exercises the limiter itself).
  const rlOff = await j('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify({ rate_limit_enabled: 'off' }),
  });
  check('PATCH /admin/settings rate_limit_enabled=off (M10 burst safety)', rlOff.status === 200 && rlOff.body?.rate_limit_enabled === 'off', JSON.stringify(rlOff.body));

  const prov = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({ name: 'Khateway Mock (smoke)', adapter: 'openai', base_url: `http://127.0.0.1:${mock.port}/v1` }),
  });
  // Anthropic-style base: bare origin, no /v1 — the adapter appends /v1/messages.
  const provAnthropic = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Anthropic Mock (smoke)',
      adapter: 'anthropic',
      base_url: `http://127.0.0.1:${mock.port}`,
      api_key: 'sk-ant-mock',
    }),
  });
  // Dual-dialect provider: ONE row speaking both upstream dialects against a
  // single openai-style /v1 base URL (joinAdapterUrl strips /v1 for anthropic).
  const provDual = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dual Mock (smoke)',
      adapters: ['openai', 'anthropic'],
      base_url: `http://127.0.0.1:${mock.port}/v1`,
      api_key: 'sk-dual-mock',
    }),
  });
  // Same idea with the OTHER paste style: bare origin, no /v1 — proves the
  // openai path inserts /v1 while anthropic keeps the origin (bidirectional
  // URL normalization).
  const provDualBare = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dual Mock Bare (smoke)',
      adapters: ['openai', 'anthropic'],
      base_url: `http://127.0.0.1:${mock.port}`,
      api_key: 'sk-dual-mock',
    }),
  });
  // Native Gemini provider (M12): one adapter row against the /v1beta root —
  // the adapter builds /models/{model}:generateContent(:streamGenerateContent?alt=sse).
  const provGemini = await j('/admin/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Gemini Mock (smoke)',
      adapters: ['gemini'],
      base_url: `http://127.0.0.1:${mock.port}/v1beta`,
      api_key: 'sk-gemini-mock',
    }),
  });
  check(
    'create mock providers (incl. dual-adapter + gemini)',
    prov.status === 201 && provAnthropic.status === 201 && provDual.status === 201 && provGemini.status === 201,
    `statuses ${prov.status}/${provAnthropic.status}/${provDual.status}/${provGemini.status}`,
  );
  check(
    'dual provider DTO echoes adapters array + legacy scalar',
    Array.isArray(provDual.body?.adapters) && provDual.body.adapters[0] === 'openai' && provDual.body.adapter === 'openai',
    JSON.stringify(provDual.body),
  );

  const mkModel = async (slug, upstream, providerId, fallbacks) =>
    j('/admin/models', {
      method: 'POST',
      body: JSON.stringify({
        provider_id: providerId,
        slug,
        upstream_model: upstream,
        display_name: `Smoke ${slug}`,
        ...(fallbacks ? { fallbacks } : {}),
      }),
    });
  const created = [];
  for (const [slug, upstream, provId, fallbacks] of [
    ['mock-chat', 'mock-chat', prov.body.id],
    ['mock-chat-429', 'mock-429', prov.body.id],
    ['mock-chat-401', 'mock-401', prov.body.id],
    ['mock-chat-500', 'mock-500', prov.body.id],
    ['mock-chat-500t', 'mock-500-text', prov.body.id],
    ['mock-claude', 'claude-mock', provAnthropic.body.id],
    ['mock-claude-429', 'claude-429', provAnthropic.body.id],
    ['mock-tools', 'mock-tools', prov.body.id],
    ['mock-claude-tools', 'claude-tools', provAnthropic.body.id],
    ['mock-dual', 'mock-chat', provDual.body.id],
    ['mock-dual-n', 'claude-mock', provDual.body.id],
    ['mock-dual-first-assistant', 'claude-mock', provDual.body.id],
    ['mock-dual-bare', 'mock-chat', provDualBare.body.id],
    ['mock-fb-500', 'mock-500', prov.body.id, ['mock-chat']],
    ['mock-fb-429', 'mock-429', prov.body.id, ['mock-chat']],
    ['mock-fb-anthropic', 'claude-429', provAnthropic.body.id, ['mock-chat']],
    ['mock-fb-dead', 'mock-500', prov.body.id, ['zzz-unknown-fallback']],
    ['mock-fb-401', 'mock-401', prov.body.id, ['mock-chat']],
    ['mock-log-json', 'mock-chat', prov.body.id],
    ['mock-log-stream', 'claude-mock', provAnthropic.body.id],
    ['mock-gemini', 'gemini-mock', provGemini.body.id],
    ['mock-gemini-tools', 'gemini-tool', provGemini.body.id],
    ['mock-gemini-400', 'gemini-400', provGemini.body.id],
    ['mock-gemini-429', 'gemini-429', provGemini.body.id],
    // M13 embeddings fixtures: openai-face embedder, a 429→fallback chain, an
    // anthropic-only provider (no embeddings endpoint → 501) and a native
    // gemini embedder (:embedContent / :batchEmbedContents).
    ['mock-emb', 'mock-emb', prov.body.id],
    ['mock-emb-fb', 'mock-emb-429', prov.body.id, ['mock-emb']],
    ['mock-emb-anthropic', 'claude-mock', provAnthropic.body.id],
    ['mock-gem-emb', 'gem-emb-mock', provGemini.body.id],
  ]) {
    const r = await mkModel(slug, upstream, provId, fallbacks);
    created.push([slug, r]);
  }
  check('create mock models', created.every(([, r]) => r.status === 201), created.map(([s, r]) => `${s}:${r.status}`).join(' '));

  // Give mock-chat pricing so cost snapshots are assertable: 3 in / 5 out at
  // $2/$8 per 1M → $0.000046 per request.
  const mockChatModel = created.find(([s]) => s === 'mock-chat');
  const priced = await j(`/admin/models/${mockChatModel[1].body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pricing_input: 2, pricing_output: 8 }),
  });
  check('set mock-chat pricing for cost assertions', priced.status === 200 && priced.body?.pricing_input === 2, JSON.stringify(priced.body));

  // mock-gemini: 4 prompt in / 6 candidates + 2 thoughts out at $2/$8 per 1M
  // → $0.000072 per request (thinking tokens bill as output).
  const geminiModel = created.find(([s]) => s === 'mock-gemini');
  const pricedGemini = await j(`/admin/models/${geminiModel[1].body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pricing_input: 2, pricing_output: 8 }),
  });
  check('set mock-gemini pricing for cost assertions', pricedGemini.status === 200, JSON.stringify(pricedGemini.body));

  // M13 embeddings models price INPUT only ($2/1M): 3 prompt tokens → $0.000006.
  for (const slug of ['mock-emb', 'mock-emb-fb', 'mock-gem-emb']) {
    const m = created.find(([s]) => s === slug);
    const r = await j(`/admin/models/${m[1].body.id}`, { method: 'PATCH', body: JSON.stringify({ pricing_input: 2 }) });
    check(`set ${slug} input pricing for cost assertions`, r.status === 200, JSON.stringify(r.body));
  }

  // -- model discovery + bulk import (saved provider) -----------------------
  const fetched = await j(`/admin/providers/${prov.body.id}/fetch-models`, { method: 'POST' });
  const fetchedIds = (fetched.body?.models ?? []).map((m) => m.id);
  check(
    'fetch-models (saved provider) normalizes upstream /models list',
    fetched.status === 200 && fetchedIds.includes('mock-chat') && fetchedIds.includes('mock-chat-stream'),
    JSON.stringify(fetched.body),
  );

  const imported = await j(`/admin/providers/${prov.body.id}/import-models`, {
    method: 'POST',
    body: JSON.stringify({ model_ids: ['mock-chat', 'mock-chat-stream', 'mock-chat', 'bad/slug+id'] }),
  });
  // mock-chat may already exist on re-runs (its own fixture is created just
  // above) — accept it as created OR skipped; bad/slug+id must always skip.
  const createdSet = new Set(imported.body?.created ?? []);
  const skippedMap = new Map((imported.body?.skipped ?? []).map((s) => [s.id, s.reason]));
  check(
    'import-models creates models, dedupes input, reports slug collisions + bad slugs',
    imported.status === 201 &&
      createdSet.size + skippedMap.size === 3 &&
      (createdSet.has('mock-chat') || skippedMap.get('mock-chat') === 'slug already in use') &&
      createdSet.has('mock-chat-stream') &&
      skippedMap.get('bad/slug+id')?.includes('slug alphabet'),
    JSON.stringify(imported.body),
  );
  const importedList = await j('/admin/models?provider_id=' + prov.body.id);
  check(
    'imported models exist with upstream id as slug + upstream_model',
    importedList.body?.some((m) => m.slug === 'mock-chat' && m.upstream_model === 'mock-chat') && importedList.body?.some((m) => m.slug === 'mock-chat-stream'),
    JSON.stringify(importedList.body?.map((m) => m.slug)),
  );

  // -- model discovery for the UNSAVED add form -----------------------------
  const preview = await j('/admin/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ adapters: ['openai'], base_url: `http://127.0.0.1:${mock.port}/v1`, api_key: 'sk-preview' }),
  });
  check(
    'fetch-models preview (unsaved form) works with in-memory key',
    preview.status === 200 && (preview.body?.models ?? []).some((m) => m.id === 'mock-chat'),
    JSON.stringify(preview.body),
  );
  const previewAnthropic = await j('/admin/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ adapters: ['anthropic'], base_url: `http://127.0.0.1:${mock.port}` }),
  });
  check(
    'fetch-models preview probes the anthropic /v1/models path',
    previewAnthropic.status === 200 && lastReq.path.endsWith('/v1/models') && (previewAnthropic.body?.models ?? []).length === 4,
    JSON.stringify({ path: lastReq.path, body: previewAnthropic.body }),
  );
  const previewBad = await j('/admin/providers/fetch-models', { method: 'POST', body: JSON.stringify({ base_url: 'not-a-url' }) });
  check('fetch-models preview validates base_url → 400', previewBad.status === 400, JSON.stringify(previewBad.body));

  // -- deployment settings (keyless-native default) ------------------------
  const settingsOff = await j('/admin/settings');
  check(
    'GET /admin/settings → enforcement off by default (keyless-native)',
    settingsOff.status === 200 && settingsOff.body?.client_key_enforcement === 'off',
    JSON.stringify(settingsOff.body),
  );
  const settingsBad = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ client_key_enforcement: 'sometimes' }) });
  check('PATCH /admin/settings rejects bad values → 400', settingsBad.status === 400, JSON.stringify(settingsBad.body));

  // -- M7 client key: every /v1 call below authenticates with it -----------
  const keyRes = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Smoke Key (smoke)' }) });
  check('create smoke client key', keyRes.status === 201 && typeof keyRes.body?.key === 'string' && keyRes.body.key.startsWith('khat-'), JSON.stringify({ ...keyRes.body, key: keyRes.body?.key?.slice(0, 9) + '…' }));
  apiKey = keyRes.body?.key ?? '';
  check('key list hides raw key + shows prefix', (await j('/admin/api-keys')).body?.every((k) => !k.key && typeof k.key_prefix === 'string'), '');

  // -- GET /v1/models ------------------------------------------------------
  const models = await j('/v1/models');
  check('GET /v1/models → 200 list envelope', models.status === 200 && models.body?.object === 'list' && Array.isArray(models.body?.data));
  const listIds = models.body?.data?.map((m) => m.id) ?? [];
  check('GET /v1/models includes enabled mock models', listIds.includes('mock-chat') && listIds.includes('mock-chat-429'), listIds.join(','));
  const anyModel = models.body?.data?.find((m) => m.id === 'mock-chat');
  check(
    'GET /v1/models entry shape (id/object/created/owned_by)',
    anyModel && anyModel.object === 'model' && typeof anyModel.created === 'number' && anyModel.owned_by === 'Khateway Mock (smoke)' && anyModel.upstream_model === 'mock-chat',
    JSON.stringify(anyModel),
  );

  const one = await j('/v1/models/mock-chat');
  check('GET /v1/models/:id → 200', one.status === 200 && one.body?.id === 'mock-chat');
  const missing = await j('/v1/models/zzz-not-real');
  check(
    'GET /v1/models/:id unknown → 404 model_not_found envelope',
    missing.status === 404 && missing.body?.error?.code === 'model_not_found' && typeof missing.body?.error?.type === 'string',
    JSON.stringify(missing.body),
  );

  // -- chat validation -----------------------------------------------------
  const noModel = await fetchOrPost('/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
  check('chat missing model → 400 param model', noModel.status === 400 && noModel.body?.error?.param === 'model', JSON.stringify(noModel.body));

  const noMessages = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat' }));
  check(
    'chat missing messages → 400 invalid_request_error',
    noMessages.status === 400 && noMessages.body?.error?.param === 'messages' && noMessages.body?.error?.type === 'invalid_request_error',
    JSON.stringify(noMessages.body),
  );

  const hostedTools = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search' }] }));
  check(
    'chat with vendor-hosted tool type → 400 explicit pointer',
    hostedTools.status === 400 && /hosted/.test(hostedTools.body?.error?.message ?? '') && hostedTools.body?.error?.param === 'tools',
    JSON.stringify(hostedTools.body),
  );

  const legacyFn = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }], functions: [] }));
  check('chat with legacy functions param → 400 pointer to tools', legacyFn.status === 400 && /legacy/.test(legacyFn.body?.error?.message ?? ''), JSON.stringify(legacyFn.body));

  const unknown = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'zzz-not-real', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'chat unknown model → 404 model_not_found',
    unknownModelOk(unknown),
    JSON.stringify(unknown.body),
  );

  // -- happy paths ---------------------------------------------------------
  const okRes = await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }),
  );
  check(
    'chat non-stream → 200 with OpenAI body + usage',
    okRes.status === 200 && okRes.body?.object === 'chat.completion' && okRes.body?.choices?.[0]?.message?.content === 'Hello from the mock upstream!' && okRes.body?.usage?.total_tokens === 8,
    JSON.stringify(okRes.body),
  );
  check(
    'chat non-stream carries x-khateway-* headers',
    okRes.headers.get('x-khateway-provider') === 'Khateway Mock (smoke)' && okRes.headers.get('x-khateway-upstream-model') === 'mock-chat',
    `${okRes.headers.get('x-khateway-provider')} / ${okRes.headers.get('x-khateway-upstream-model')}`,
  );

  // -- dual-adapter provider (one row, both upstream dialects) --------------
  const dualOpenai = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-dual', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'dual provider: openai dialect → openai adapter (passthrough, shared /v1 base)',
    dualOpenai.status === 200 && dualOpenai.body?.object === 'chat.completion' && lastReq.path.endsWith('/chat/completions') && lastReq.headers.authorization === 'Bearer sk-dual-mock',
    JSON.stringify({ path: lastReq.path, auth: lastReq.headers.authorization, body: dualOpenai.body }),
  );

  const dualAnthropic = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-dual', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'dual provider: anthropic dialect → anthropic adapter (/v1 deduped from shared base)',
    dualAnthropic.status === 200 && dualAnthropic.body?.type === 'message' && lastReq.path.endsWith('/v1/messages') && lastReq.headers['x-api-key'] === 'sk-dual-mock',
    JSON.stringify({ path: lastReq.path, auth: lastReq.headers['x-api-key'], body: dualAnthropic.body }),
  );

  const dualAssistantFirst = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-dual-first-assistant', max_tokens: 32, messages: [{ role: 'assistant', content: 'prefill' }, { role: 'user', content: 'hi' }] }));
  check(
    'dual provider: untranslatable on anthropic → retried via openai adapter → 200 attempts 2',
    dualAssistantFirst.status === 200 && dualAssistantFirst.body?.type === 'message' && lastReq.path.endsWith('/chat/completions') && dualAssistantFirst.headers.get('x-khateway-attempts') === '2',
    JSON.stringify({ attempts: dualAssistantFirst.headers.get('x-khateway-attempts'), path: lastReq.path, body: dualAssistantFirst.body }),
  );

  const dualOpenaiN = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-dual-n', messages: [{ role: 'user', content: 'hi' }], n: 2 }));
  check(
    'dual provider: openai n=2 served natively (no retry needed) → 200 attempts 1',
    dualOpenaiN.status === 200 && dualOpenaiN.body?.object === 'chat.completion' && dualOpenaiN.headers.get('x-khateway-attempts') === '1',
    JSON.stringify({ attempts: dualOpenaiN.headers.get('x-khateway-attempts'), body: dualOpenaiN.body }),
  );

  // -- bare-origin dual provider: BOTH paste styles normalize correctly -----
  const bareOpenai = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-dual-bare', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'bare-origin dual provider: openai dialect gets /v1 inserted → /v1/chat/completions',
    bareOpenai.status === 200 && bareOpenai.body?.object === 'chat.completion' && lastReq.path.endsWith('/v1/chat/completions'),
    JSON.stringify({ path: lastReq.path, body: bareOpenai.body }),
  );
  const bareAnthropic = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-dual-bare', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'bare-origin dual provider: anthropic dialect keeps origin → /v1/messages',
    bareAnthropic.status === 200 && bareAnthropic.body?.type === 'message' && lastReq.path.endsWith('/v1/messages') && lastReq.headers['x-api-key'] === 'sk-dual-mock',
    JSON.stringify({ path: lastReq.path, body: bareAnthropic.body }),
  );

  const streamRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const streamText = await streamRes.text();
  check(
    'chat stream → 200 SSE passthrough',
    streamRes.status === 200 && (streamRes.headers.get('content-type') ?? '').includes('text/event-stream') && streamText.includes('data: [DONE]') && streamText.includes('Hello from the mock'),
    `ct=${streamRes.headers.get('content-type')} len=${streamText.length}`,
  );

  // stream_options.include_usage → forwarded upstream; the mock echoes a final
  // usage-only chunk (empty choices) which must relay untouched.
  const inclUsageRes = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } }),
  });
  const inclUsageText = await inclUsageRes.text();
  check(
    'chat stream stream_options.include_usage → forwarded upstream, final usage chunk relayed',
    inclUsageRes.status === 200 && lastReq.body?.stream_options?.include_usage === true && parseDataLines(inclUsageText).some((ch) => Array.isArray(ch?.choices) && ch.choices.length === 0 && ch?.usage?.total_tokens === 8),
    `upstream=${JSON.stringify(lastReq.body?.stream_options)} tail=${inclUsageText.slice(-160)}`,
  );

  const pinned = await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'Khateway Mock (smoke)/mock-chat', messages: [{ role: 'user', content: 'hi' }] }),
  );
  check('chat provider-pinned model resolves → 200', pinned.status === 200, JSON.stringify(pinned.body));

  const badPin = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'Nope/mock-chat', messages: [{ role: 'user', content: 'hi' }] }));
  check('chat pinned to unknown provider → 404', badPin.status === 404 && badPin.body?.error?.code === 'model_not_found', JSON.stringify(badPin.body));

  // ==================================================================
  // M4: cross-dialect matrix — every (client dialect × upstream adapter)
  // cell, error mapping in both envelopes, and translation assertions on
  // what the mock upstream actually received.
  // ==================================================================

  // -- /v1/messages validation (anthropic dialect contract) ----------------
  const anthNoModel = await fetchOrPost('/v1/messages', JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }));
  check(
    'messages missing model → 400 anthropic envelope, param model',
    anthNoModel.status === 400 && anthNoModel.body?.type === 'error' && anthNoModel.body?.error?.type === 'invalid_request_error' && anthNoModel.body?.error?.message.includes('model'),
    JSON.stringify(anthNoModel.body),
  );

  const anthNoMax = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-claude', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'messages missing max_tokens → 400 (required in anthropic dialect)',
    anthNoMax.status === 400 && anthNoMax.body?.error?.message.includes('max_tokens'),
    JSON.stringify(anthNoMax.body),
  );

  const anthHostedTools = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }));
  check(
    'messages with server-hosted tool → 400 explicit pointer',
    anthHostedTools.status === 400 && /hosted/.test(anthHostedTools.body?.error?.message ?? ''),
    JSON.stringify(anthHostedTools.body),
  );

  const anthUnknown = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'zzz-not-real', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'messages unknown model → 404 not_found_error',
    anthUnknown.status === 404 && anthUnknown.body?.error?.type === 'not_found_error',
    JSON.stringify(anthUnknown.body),
  );

  // -- anthropic client → anthropic upstream (identity passthrough) --------
  const anthAnth = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'messages → anthropic upstream passthrough: message shape + usage',
    anthAnth.status === 200 && anthAnth.body?.type === 'message' && anthAnth.body?.content?.[0]?.text === 'Hello from the mock upstream!' && anthAnth.body?.stop_reason === 'end_turn' && anthAnth.body?.usage?.input_tokens === 7 && anthAnth.body?.usage?.output_tokens === 5,
    JSON.stringify(anthAnth.body),
  );
  check(
    'messages → anthropic upstream: identity passthrough hit /v1/messages untouched',
    lastReq.path.endsWith('/v1/messages') && lastReq.body?.max_tokens === 32 && lastReq.body?.stream === false,
    `${lastReq.path} ${JSON.stringify(lastReq.body)}`,
  );

  const anthAnthStream = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-claude', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const anthAnthStreamText = await anthAnthStream.text();
  check(
    'messages stream → anthropic upstream passthrough (anthropic SSE events)',
    anthAnthStream.status === 200 && anthAnthStreamText.includes('event: message_start') && anthAnthStreamText.includes('content_block_delta') && anthAnthStreamText.includes('event: message_stop'),
    `ct=${anthAnthStream.headers.get('content-type')} len=${anthAnthStreamText.length}`,
  );

  const anthAnth429 = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-claude-429', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'messages → anthropic upstream 429 kept in anthropic envelope',
    anthAnth429.status === 429 && anthAnth429.body?.type === 'error' && anthAnth429.body?.error?.type === 'rate_limit_error' && anthAnth429.body?.error?.message === 'Slow down',
    JSON.stringify(anthAnth429.body),
  );

  // -- anthropic client → openai upstream (request + response translation) --
  const anthOpenai = await fetchOrPost(
    '/v1/messages',
    JSON.stringify({ model: 'mock-chat', max_tokens: 256, system: 'Be terse.', messages: [{ role: 'user', content: 'hi' }] }),
  );
  check(
    'messages → openai upstream: translated to anthropic message + mapped usage',
    anthOpenai.status === 200 && anthOpenai.body?.type === 'message' && anthOpenai.body?.content?.[0]?.text === 'Hello from the mock upstream!' && anthOpenai.body?.stop_reason === 'end_turn' && anthOpenai.body?.usage?.input_tokens === 3 && anthOpenai.body?.usage?.output_tokens === 5,
    JSON.stringify(anthOpenai.body),
  );
  check(
    'messages → openai upstream: system param became leading system message, max_tokens forwarded',
    lastReq.path.endsWith('/chat/completions') && lastReq.body?.messages?.[0]?.role === 'system' && lastReq.body?.messages?.[0]?.content === 'Be terse.' && lastReq.body?.messages?.[1]?.role === 'user' && lastReq.body?.max_tokens === 256 && lastReq.body?.model === 'mock-chat',
    JSON.stringify(lastReq.body),
  );

  const anthOpenaiStream = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-chat', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const anthOpenaiStreamText = await anthOpenaiStream.text();
  check(
    'messages stream → openai upstream: openai chunks translated to anthropic events',
    anthOpenaiStream.status === 200
      && (anthOpenaiStream.headers.get('content-type') ?? '').includes('text/event-stream')
      && anthOpenaiStreamText.includes('event: message_start')
      && anthOpenaiStreamText.includes('"text_delta"')
      && anthOpenaiStreamText.includes('Hello from the mock')
      && anthOpenaiStreamText.includes('"stop_reason":"end_turn"')
      && anthOpenaiStreamText.includes('event: message_stop'),
    `ct=${anthOpenaiStream.headers.get('content-type')} len=${anthOpenaiStreamText.length}`,
  );

  const anthOpenai401 = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-chat-401', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'messages → openai upstream 401 mapped into anthropic envelope (declared type preserved, status kept)',
    anthOpenai401.status === 401 && anthOpenai401.body?.type === 'error' && anthOpenai401.body?.error?.type === 'invalid_request_error' && anthOpenai401.body?.error?.message === 'Invalid mock API key',
    JSON.stringify(anthOpenai401.body),
  );

  // -- openai client → anthropic upstream (request + response translation) --
  const openaiAnth = await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'mock-claude', messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }] }),
  );
  check(
    'chat → anthropic upstream: translated to openai completion + merged usage',
    openaiAnth.status === 200 && openaiAnth.body?.object === 'chat.completion' && openaiAnth.body?.choices?.[0]?.message?.content === 'Hello from the mock upstream!' && openaiAnth.body?.choices?.[0]?.finish_reason === 'stop' && openaiAnth.body?.usage?.total_tokens === 12,
    JSON.stringify(openaiAnth.body),
  );
  check(
    'chat → anthropic upstream: x-api-key + anthropic-version, system positioning, default max_tokens',
    lastReq.path.endsWith('/v1/messages') && lastReq.headers['x-api-key'] === 'sk-ant-mock' && lastReq.headers['anthropic-version'] === '2023-06-01' && lastReq.body?.system === 'Be terse.' && lastReq.body?.max_tokens === 4096 && lastReq.body?.model === 'claude-mock' && lastReq.body?.messages?.[0]?.role === 'user',
    `${JSON.stringify(lastReq.headers)} ${JSON.stringify(lastReq.body)}`,
  );

  await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'mock-claude', max_tokens: 100, stop: ['END'], messages: [{ role: 'user', content: 'hi' }] }),
  );
  check(
    'chat → anthropic upstream: max_tokens + stop → stop_sequences',
    lastReq.body?.max_tokens === 100 && Array.isArray(lastReq.body?.stop_sequences) && lastReq.body.stop_sequences[0] === 'END',
    JSON.stringify(lastReq.body),
  );

  const openaiAnthStream = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-claude', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const openaiAnthStreamText = await openaiAnthStream.text();
  check(
    'chat stream → anthropic upstream: anthropic events translated to openai chunks + [DONE]',
    openaiAnthStream.status === 200
      && (openaiAnthStream.headers.get('content-type') ?? '').includes('text/event-stream')
      && openaiAnthStreamText.includes('"object":"chat.completion.chunk"')
      && openaiAnthStreamText.includes('Hello from the mock')
      && openaiAnthStreamText.includes(' anthropic stream!')
      && openaiAnthStreamText.includes('"finish_reason":"stop"')
      && openaiAnthStreamText.trimEnd().endsWith('data: [DONE]'),
    `ct=${openaiAnthStream.headers.get('content-type')} len=${openaiAnthStreamText.length}`,
  );

  const openaiAnthN = await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'mock-claude', n: 4, messages: [{ role: 'user', content: 'hi' }] }),
  );
  check(
    'chat → anthropic upstream with n>1 → 400 untranslatable',
    openaiAnthN.status === 400 && openaiAnthN.body?.error?.code === 'untranslatable_request',
    JSON.stringify(openaiAnthN.body),
  );

  const openaiAnthAssistantFirst = await fetchOrPost(
    '/v1/chat/completions',
    JSON.stringify({ model: 'mock-claude', messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'hello' }] }),
  );
  check(
    'chat → anthropic upstream assistant-first → 400 untranslatable',
    openaiAnthAssistantFirst.status === 400 && openaiAnthAssistantFirst.body?.error?.code === 'untranslatable_request',
    JSON.stringify(openaiAnthAssistantFirst.body),
  );

  const openaiAnth429 = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-claude-429', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'chat → anthropic upstream 429 mapped into openai envelope',
    openaiAnth429.status === 429 && openaiAnth429.body?.error?.type === 'rate_limit_error' && openaiAnth429.body?.error?.message === 'Slow down',
    JSON.stringify(openaiAnth429.body),
  );

  // ==================================================================
  // M5: /v1/responses — third client dialect. Upstream adapters stay
  // chat-completions (openai) + Messages (anthropic); every responses
  // pairing is translated back into Responses objects/events (there is
  // no responses upstream adapter to passthrough to).
  // ==================================================================

  // -- /v1/responses validation --------------------------------------------
  const respNoModel = await fetchOrPost('/v1/responses', JSON.stringify({ input: 'hi' }));
  check(
    'responses missing model → 400 param model (openai envelope)',
    respNoModel.status === 400 && respNoModel.body?.error?.param === 'model' && typeof respNoModel.body?.error?.type === 'string',
    JSON.stringify(respNoModel.body),
  );

  const respNoInput = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat' }));
  check('responses missing input → 400 param input', respNoInput.status === 400 && respNoInput.body?.error?.param === 'input', JSON.stringify(respNoInput.body));

  const respHostedTools = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat', input: 'hi', tools: [{ type: 'web_search' }] }));
  check('responses with hosted tool → 400 explicit pointer', respHostedTools.status === 400 && /hosted/.test(respHostedTools.body?.error?.message ?? ''), JSON.stringify(respHostedTools.body));

  const respState = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat', input: 'hi', previous_response_id: 'resp_old' }));
  check(
    'responses with previous_response_id → 400 stateless pointer',
    respState.status === 400 && /stateless/.test(respState.body?.error?.message ?? ''),
    JSON.stringify(respState.body),
  );

  const respMaxSmall = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat', input: 'hi', max_output_tokens: 5 }));
  check(
    'responses max_output_tokens < 16 → 400',
    respMaxSmall.status === 400 && respMaxSmall.body?.error?.param === 'max_output_tokens',
    JSON.stringify(respMaxSmall.body),
  );

  const respUnknown = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'zzz-not-real', input: 'hi' }));
  check(
    'responses unknown model → 404 model_not_found',
    respUnknown.status === 404 && respUnknown.body?.error?.code === 'model_not_found',
    JSON.stringify(respUnknown.body),
  );

  // -- responses → openai upstream (request + response translation) --------
  const respOpenai = await fetchOrPost(
    '/v1/responses',
    JSON.stringify({ model: 'mock-chat', input: 'hi', instructions: 'Be terse.', max_output_tokens: 256 }),
  );
  check(
    'responses → openai upstream: translated to a Responses object + mapped usage',
    respOpenai.status === 200
      && respOpenai.body?.object === 'response'
      && respOpenai.body?.status === 'completed'
      && respOpenai.body?.model === 'mock-chat'
      && respOpenai.body?.output?.[0]?.type === 'message'
      && respOpenai.body?.output?.[0]?.role === 'assistant'
      && respOpenai.body?.output?.[0]?.content?.[0]?.type === 'output_text'
      && respOpenai.body?.output?.[0]?.content?.[0]?.text === 'Hello from the mock upstream!'
      && respOpenai.body?.usage?.input_tokens === 3
      && respOpenai.body?.usage?.output_tokens === 5
      && respOpenai.body?.usage?.total_tokens === 8
      && respOpenai.body?.incomplete_details === null,
    JSON.stringify(respOpenai.body),
  );
  check(
    'responses → openai upstream: instructions → system message, max_output_tokens → max_tokens',
    lastReq.path.endsWith('/chat/completions')
      && lastReq.body?.messages?.[0]?.role === 'system'
      && lastReq.body?.messages?.[0]?.content === 'Be terse.'
      && lastReq.body?.messages?.[1]?.content === 'hi'
      && lastReq.body?.max_tokens === 256
      && lastReq.body?.stream === false
      && lastReq.body?.model === 'mock-chat',
    JSON.stringify(lastReq.body),
  );

  const respItems = await fetchOrPost(
    '/v1/responses',
    JSON.stringify({
      model: 'mock-chat',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }],
    }),
  );
  check(
    'responses input items with text parts fold into one message',
    respItems.status === 200 && lastReq.body?.messages?.length === 1 && lastReq.body?.messages?.[0]?.content === 'a\nb',
    JSON.stringify(lastReq.body),
  );

  const respOpenaiStream = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-chat', input: 'hi', stream: true }),
  });
  const respOpenaiStreamText = await respOpenaiStream.text();
  check(
    'responses stream → openai upstream: chat chunks translated to Responses events',
    respOpenaiStream.status === 200
      && (respOpenaiStream.headers.get('content-type') ?? '').includes('text/event-stream')
      && respOpenaiStreamText.startsWith('event: response.created\n')
      && respOpenaiStreamText.includes('"status":"in_progress"')
      && respOpenaiStreamText.includes('event: response.output_item.added')
      && respOpenaiStreamText.includes('event: response.content_part.added')
      && respOpenaiStreamText.includes('event: response.output_text.delta')
      && respOpenaiStreamText.includes('Hello from the mock')
      && respOpenaiStreamText.includes('event: response.output_text.done')
      && respOpenaiStreamText.includes('event: response.content_part.done')
      && respOpenaiStreamText.includes('event: response.output_item.done')
      && respOpenaiStreamText.includes('event: response.completed'),
    `ct=${respOpenaiStream.headers.get('content-type')} len=${respOpenaiStreamText.length}`,
  );
  const respCompleted = parseSseEvent(respOpenaiStreamText, 'response.completed');
  check(
    'responses stream → response.completed carries assembled text + status + usage',
    respCompleted?.sequence_number !== undefined
      && respCompleted?.response?.status === 'completed'
      && respCompleted?.response?.output?.[0]?.content?.[0]?.text === 'Hello from the mock stream!'
      && respCompleted?.response?.incomplete_details === null
      && typeof respCompleted?.response?.usage?.total_tokens === 'number',
    JSON.stringify(respCompleted)?.slice(0, 300),
  );

  const resp429 = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat-429', input: 'hi' }));
  check(
    'responses → openai upstream 429 kept in openai envelope',
    resp429.status === 429 && resp429.body?.error?.type === 'rate_limit_error' && resp429.body?.error?.message === 'Slow down',
    JSON.stringify(resp429.body),
  );

  const resp401 = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat-401', input: 'hi' }));
  check(
    'responses → openai upstream 401 message+code passthrough',
    resp401.status === 401 && resp401.body?.error?.message === 'Invalid mock API key' && resp401.body?.error?.code === 'invalid_api_key',
    JSON.stringify(resp401.body),
  );

  // -- responses → anthropic upstream (request + response translation) -----
  const respAnth = await fetchOrPost(
    '/v1/responses',
    JSON.stringify({ model: 'mock-claude', input: 'hi', instructions: 'Be terse.' }),
  );
  check(
    'responses → anthropic upstream: translated to a Responses object + mapped usage',
    respAnth.status === 200
      && respAnth.body?.object === 'response'
      && respAnth.body?.status === 'completed'
      && respAnth.body?.output?.[0]?.content?.[0]?.text === 'Hello from the mock upstream!'
      && respAnth.body?.usage?.input_tokens === 7
      && respAnth.body?.usage?.output_tokens === 5
      && respAnth.body?.usage?.total_tokens === 12,
    JSON.stringify(respAnth.body),
  );
  check(
    'responses → anthropic upstream: instructions → system, default max_tokens 4096',
    lastReq.path.endsWith('/v1/messages') && lastReq.body?.system === 'Be terse.' && lastReq.body?.max_tokens === 4096 && lastReq.body?.model === 'claude-mock',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-claude', input: 'hi', max_output_tokens: 100 }));
  check(
    'responses → anthropic upstream: max_output_tokens forwarded as max_tokens',
    lastReq.body?.max_tokens === 100,
    JSON.stringify(lastReq.body),
  );

  const respAnthStream = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-claude', input: 'hi', stream: true }),
  });
  const respAnthStreamText = await respAnthStream.text();
  check(
    'responses stream → anthropic upstream: Messages events translated to Responses events',
    respAnthStream.status === 200
      && (respAnthStream.headers.get('content-type') ?? '').includes('text/event-stream')
      && respAnthStreamText.includes('event: response.created')
      && respAnthStreamText.includes('event: response.output_text.delta')
      && respAnthStreamText.includes('Hello from the mock')
      && respAnthStreamText.includes(' anthropic stream!')
      && respAnthStreamText.includes('event: response.completed'),
    `ct=${respAnthStream.headers.get('content-type')} len=${respAnthStreamText.length}`,
  );
  const respAnthCompleted = parseSseEvent(respAnthStreamText, 'response.completed');
  check(
    'responses stream → anthropic upstream: completed usage mapped from Messages events',
    respAnthCompleted?.response?.usage?.input_tokens === 7
      && respAnthCompleted?.response?.usage?.output_tokens === 11
      && respAnthCompleted?.response?.output?.[0]?.content?.[0]?.text === 'Hello from the mock anthropic stream!',
    JSON.stringify(respAnthCompleted)?.slice(0, 300),
  );

  const respAnth429 = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-claude-429', input: 'hi' }));
  check(
    'responses → anthropic upstream 429 mapped into openai envelope',
    respAnth429.status === 429 && respAnth429.body?.error?.type === 'rate_limit_error' && respAnth429.body?.error?.message === 'Slow down',
    JSON.stringify(respAnth429.body),
  );

  // ==================================================================
  // M6: tool calling + vision across every dialect pairing, and
  // fallback-chain retries (models.fallbacks → ordered failover on
  // 429/5xx/timeout/network).
  // ==================================================================

  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  // ---- request-side: tool definitions + tool_choice --------------------

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-chat',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  }));
  check(
    'M6 chat tools → openai upstream: nested function shape + tool_choice + parallel_tool_calls',
    lastReq.body?.tools?.[0]?.type === 'function'
      && lastReq.body?.tools?.[0]?.function?.name === 'get_weather'
      && lastReq.body?.tools?.[0]?.function?.parameters?.properties?.city?.type === 'string'
      && lastReq.body?.tool_choice === 'auto'
      && lastReq.body?.parallel_tool_calls === false,
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-claude',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }));
  check(
    'M6 chat tools → anthropic upstream: input_schema + tool_choice {type:tool,name}',
    Array.isArray(lastReq.body?.tools) && lastReq.body.tools[0]?.name === 'get_weather'
      && lastReq.body.tools[0]?.input_schema?.type === 'object'
      && lastReq.body.tool_choice?.type === 'tool' && lastReq.body.tool_choice?.name === 'get_weather',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/messages', JSON.stringify({
    model: 'mock-chat', max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
  }));
  check(
    'M6 messages tools → openai upstream: nested shape + tool_choice required',
    lastReq.body?.tools?.[0]?.type === 'function' && lastReq.body?.tools?.[0]?.function?.name === 'get_weather'
      && lastReq.body?.tools?.[0]?.function?.parameters?.properties?.city?.type === 'string'
      && lastReq.body?.tool_choice === 'required',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/messages', JSON.stringify({
    model: 'mock-chat', max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true },
  }));
  check(
    'M6 messages tool_choice {type:tool,disable_parallel} → openai {type:function} + parallel_tool_calls false',
    lastReq.body?.tool_choice?.type === 'function' && lastReq.body?.tool_choice?.function?.name === 'get_weather'
      && lastReq.body?.parallel_tool_calls === false,
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-claude',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: 'none',
  }));
  check(
    'M6 chat tool_choice none → anthropic upstream: tools omitted entirely',
    lastReq.body?.tools === undefined && lastReq.body?.tool_choice === undefined,
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/responses', JSON.stringify({
    model: 'mock-chat', input: 'hi',
    tools: [{ type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }],
    tool_choice: 'auto',
  }));
  check(
    'M6 responses tools → openai upstream: flat def re-nested',
    lastReq.body?.tools?.[0]?.type === 'function' && lastReq.body?.tools?.[0]?.function?.name === 'get_weather'
      && lastReq.body?.tools?.[0]?.function?.description === 'Weather' && lastReq.body?.tool_choice === 'auto',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/responses', JSON.stringify({
    model: 'mock-claude', input: 'hi',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    tool_choice: 'required',
  }));
  check(
    'M6 responses tools → anthropic upstream: input_schema + {type:any}',
    lastReq.body?.tools?.[0]?.name === 'get_weather' && lastReq.body?.tools?.[0]?.input_schema?.type === 'object'
      && lastReq.body?.tool_choice?.type === 'any',
    JSON.stringify(lastReq.body),
  );

  // ---- request-side: tool conversations --------------------------------

  const toolConv = [
    { role: 'user', content: 'Weather in Paris?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '18C' },
  ];
  await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: toolConv }));
  check(
    'M6 chat tool conversation → openai upstream: tool_calls + tool message preserved',
    lastReq.body?.messages?.[1]?.tool_calls?.[0]?.function?.name === 'get_weather'
      && lastReq.body?.messages?.[1]?.tool_calls?.[0]?.function?.arguments === '{"city":"Paris"}'
      && lastReq.body?.messages?.[2]?.role === 'tool' && lastReq.body?.messages?.[2]?.tool_call_id === 'call_1'
      && lastReq.body?.messages?.[2]?.content === '18C',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-claude', messages: toolConv }));
  check(
    'M6 chat tool conversation → anthropic upstream: tool_use + tool_result blocks',
    Array.isArray(lastReq.body?.messages?.[1]?.content) && lastReq.body?.messages?.[1]?.content?.[0]?.type === 'tool_use'
      && lastReq.body?.messages?.[1]?.content?.[0]?.id === 'call_1'
      && lastReq.body?.messages?.[1]?.content?.[0]?.input?.city === 'Paris'
      && lastReq.body?.messages?.[2]?.role === 'user'
      && lastReq.body?.messages?.[2]?.content?.[0]?.type === 'tool_result'
      && lastReq.body?.messages?.[2]?.content?.[0]?.tool_use_id === 'call_1'
      && lastReq.body?.messages?.[2]?.content?.[0]?.content === '18C',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/messages', JSON.stringify({
    model: 'mock-chat', max_tokens: 32,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'result text' }] }],
  }));
  check(
    'M6 messages tool_result → openai upstream role:tool message',
    lastReq.body?.messages?.[0]?.role === 'tool' && lastReq.body?.messages?.[0]?.tool_call_id === 'toolu_9'
      && lastReq.body?.messages?.[0]?.content === 'result text',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/responses', JSON.stringify({
    model: 'mock-chat',
    input: [
      { type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_7', output: '18C' },
    ],
  }));
  check(
    'M6 responses function_call items → openai upstream: assistant.tool_calls + tool message',
    lastReq.body?.messages?.[0]?.role === 'assistant' && lastReq.body?.messages?.[0]?.tool_calls?.[0]?.id === 'call_7'
      && lastReq.body?.messages?.[0]?.tool_calls?.[0]?.function?.arguments === '{"city":"Paris"}'
      && lastReq.body?.messages?.[1]?.role === 'tool' && lastReq.body?.messages?.[1]?.tool_call_id === 'call_7'
      && lastReq.body?.messages?.[1]?.content === '18C',
    JSON.stringify(lastReq.body),
  );

  // ---- request-side: vision --------------------------------------------

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-claude',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: PNG } }] }],
  }));
  check(
    'M6 chat image data URL → anthropic upstream base64 image block',
    Array.isArray(lastReq.body?.messages?.[0]?.content) && lastReq.body?.messages?.[0]?.content?.[0]?.type === 'text'
      && lastReq.body?.messages?.[0]?.content?.[0]?.text === 'What is this?'
      && lastReq.body?.messages?.[0]?.content?.[1]?.type === 'image'
      && lastReq.body?.messages?.[0]?.content?.[1]?.source?.type === 'base64'
      && lastReq.body?.messages?.[0]?.content?.[1]?.source?.media_type === 'image/png'
      && lastReq.body?.messages?.[0]?.content?.[1]?.source?.data === 'iVBORw0KGgo=',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-chat',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'low' } }] }],
  }));
  check(
    'M6 chat image → openai upstream image_url part with detail preserved',
    Array.isArray(lastReq.body?.messages?.[0]?.content) && lastReq.body?.messages?.[0]?.content?.[0]?.type === 'image_url'
      && lastReq.body?.messages?.[0]?.content?.[0]?.image_url?.url === 'https://example.com/cat.png'
      && lastReq.body?.messages?.[0]?.content?.[0]?.image_url?.detail === 'low',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/messages', JSON.stringify({
    model: 'mock-chat', max_tokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }],
  }));
  check(
    'M6 messages base64 image → openai upstream data URL image_url part',
    Array.isArray(lastReq.body?.messages?.[0]?.content) && lastReq.body?.messages?.[0]?.content?.[0]?.type === 'text'
      && lastReq.body?.messages?.[0]?.content?.[1]?.type === 'image_url'
      && lastReq.body?.messages?.[0]?.content?.[1]?.image_url?.url === PNG,
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/responses', JSON.stringify({
    model: 'mock-claude',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'https://example.com/cat.png' }] }],
  }));
  check(
    'M6 responses input_image → anthropic upstream url-source image block',
    Array.isArray(lastReq.body?.messages?.[0]?.content) && lastReq.body?.messages?.[0]?.content?.[1]?.type === 'image'
      && lastReq.body?.messages?.[0]?.content?.[1]?.source?.type === 'url'
      && lastReq.body?.messages?.[0]?.content?.[1]?.source?.url === 'https://example.com/cat.png',
    JSON.stringify(lastReq.body),
  );

  const badImg = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'ftp://example.com/x' }] }] }));
  check('M6 unsupported image scheme → 400', badImg.status === 400 && /data: URL or an http/.test(badImg.body?.error?.message ?? ''), JSON.stringify(badImg.body));

  // ---- response-side: tool calls (JSON) ---------------------------------

  const oaiTools = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-tools', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 chat ← openai upstream tool-call completion passthrough',
    oaiTools.status === 200 && oaiTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.id === 'call_1'
      && oaiTools.body?.choices?.[0]?.finish_reason === 'tool_calls',
    JSON.stringify(oaiTools.body),
  );

  const anthFromOaiTools = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-tools', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 messages ← openai upstream tool_calls → tool_use block + stop_reason tool_use',
    anthFromOaiTools.status === 200 && anthFromOaiTools.body?.content?.[0]?.type === 'tool_use'
      && anthFromOaiTools.body?.content?.[0]?.id === 'call_1' && anthFromOaiTools.body?.content?.[0]?.name === 'get_weather'
      && anthFromOaiTools.body?.content?.[0]?.input?.city === 'Paris'
      && anthFromOaiTools.body?.stop_reason === 'tool_use'
      && anthFromOaiTools.body?.usage?.input_tokens === 3 && anthFromOaiTools.body?.usage?.output_tokens === 5,
    JSON.stringify(anthFromOaiTools.body),
  );

  const respFromOaiTools = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-tools', input: 'hi' }));
  check(
    'M6 responses ← openai upstream tool_calls → function_call output item',
    respFromOaiTools.status === 200 && respFromOaiTools.body?.output?.length === 1
      && respFromOaiTools.body?.output?.[0]?.type === 'function_call'
      && respFromOaiTools.body?.output?.[0]?.call_id === 'call_1' && respFromOaiTools.body?.output?.[0]?.name === 'get_weather'
      && respFromOaiTools.body?.output?.[0]?.arguments === '{"city":"Paris"}' && respFromOaiTools.body?.output?.[0]?.status === 'completed'
      && respFromOaiTools.body?.usage?.input_tokens === 3,
    JSON.stringify(respFromOaiTools.body),
  );

  const oaiFromAnthTools = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-claude-tools', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 chat ← anthropic upstream tool_use → tool_calls + finish_reason tool_calls',
    oaiFromAnthTools.status === 200 && oaiFromAnthTools.body?.choices?.[0]?.message?.content === 'Calling tool'
      && oaiFromAnthTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.id === 'toolu_1'
      && oaiFromAnthTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather'
      && oaiFromAnthTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments === '{"city":"Paris"}'
      && oaiFromAnthTools.body?.choices?.[0]?.finish_reason === 'tool_calls',
    JSON.stringify(oaiFromAnthTools.body),
  );

  const respFromAnthTools = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-claude-tools', input: 'hi' }));
  check(
    'M6 responses ← anthropic upstream tool_use → message + function_call items',
    respFromAnthTools.status === 200 && respFromAnthTools.body?.output?.[0]?.type === 'message'
      && respFromAnthTools.body?.output?.[0]?.content?.[0]?.text === 'Calling tool'
      && respFromAnthTools.body?.output?.[1]?.type === 'function_call'
      && respFromAnthTools.body?.output?.[1]?.call_id === 'toolu_1'
      && respFromAnthTools.body?.output?.[1]?.arguments === '{"city":"Paris"}',
    JSON.stringify(respFromAnthTools.body),
  );

  // ---- response-side: tool-call streams ----------------------------------

  const anthToolsStream = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-tools', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const anthToolsStreamText = await anthToolsStream.text();
  const anthToolDeltas = parseSseEvents(anthToolsStreamText, 'content_block_delta');
  const anthToolStart = parseSseEvents(anthToolsStreamText, 'content_block_start').find((e) => e?.content_block?.type === 'tool_use');
  const anthToolArgs = anthToolDeltas.map((e) => e?.delta?.partial_json ?? '').join('');
  const anthToolStop = parseSseEvents(anthToolsStreamText, 'message_delta').map((e) => e?.delta?.stop_reason ?? '');
  check(
    'M6 messages stream ← openai tool-call chunks → tool_use events + stop_reason',
    anthToolsStream.status === 200
      && anthToolStart?.content_block?.id === 'call_1' && anthToolStart?.content_block?.name === 'get_weather'
      && anthToolArgs === '{"city":"Paris"}'
      && anthToolStop.includes('tool_use')
      && anthToolsStreamText.includes('event: message_stop'),
    `args=${anthToolArgs} stops=${JSON.stringify(anthToolStop)}`,
  );

  const respToolsStream = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-tools', input: 'hi', stream: true }),
  });
  const respToolsStreamText = await respToolsStream.text();
  check(
    'M6 responses stream ← openai tool-call chunks → function_call events',
    respToolsStream.status === 200
      && respToolsStreamText.startsWith('event: response.created\n')
      && respToolsStreamText.includes('event: response.output_item.added')
      && respToolsStreamText.includes('"type":"function_call"')
      && respToolsStreamText.includes('event: response.function_call_arguments.delta'),
    `len=${respToolsStreamText.length}`,
  );
  const respToolsCompleted = parseSseEvent(respToolsStreamText, 'response.completed');
  check(
    'M6 responses stream tool-call completed: assembled arguments + status',
    respToolsCompleted?.response?.status === 'completed'
      && respToolsCompleted?.response?.output?.length === 1
      && respToolsCompleted?.response?.output?.[0]?.type === 'function_call'
      && respToolsCompleted?.response?.output?.[0]?.call_id === 'call_1'
      && respToolsCompleted?.response?.output?.[0]?.arguments === '{"city":"Paris"}',
    JSON.stringify(respToolsCompleted)?.slice(0, 400),
  );

  const oaiToolsStream = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-claude-tools', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const oaiToolsStreamText = await oaiToolsStream.text();
  const oaiToolChunks = parseDataLines(oaiToolsStreamText);
  const oaiToolFirst = oaiToolChunks.map((ch) => ch?.choices?.[0]?.delta?.tool_calls?.[0]).find((tc) => tc?.id);
  const oaiToolArgs = oaiToolChunks
    .map((ch) => ch?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? '')
    .join('');
  const oaiToolFinish = oaiToolChunks.map((ch) => ch?.choices?.[0]?.finish_reason).find((f) => f);
  check(
    'M6 chat stream ← anthropic tool_use events → openai tool_calls chunks',
    oaiToolsStream.status === 200
      && oaiToolFirst?.id === 'toolu_1' && oaiToolFirst?.function?.name === 'get_weather'
      && oaiToolArgs === '{"city":"Paris"}'
      && oaiToolFinish === 'tool_calls'
      && oaiToolsStreamText.trimEnd().endsWith('data: [DONE]'),
    `args=${oaiToolArgs} finish=${oaiToolFinish}`,
  );

  const respAnthToolsStream = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-claude-tools', input: 'hi', stream: true }),
  });
  const respAnthToolsStreamText = await respAnthToolsStream.text();
  const respAnthToolsCompleted = parseSseEvent(respAnthToolsStreamText, 'response.completed');
  check(
    'M6 responses stream ← anthropic tool_use → message + function_call output',
    respAnthToolsCompleted?.response?.status === 'completed'
      && respAnthToolsCompleted?.response?.output?.[0]?.type === 'message'
      && respAnthToolsCompleted?.response?.output?.[0]?.content?.[0]?.text === 'Calling tool'
      && respAnthToolsCompleted?.response?.output?.[1]?.type === 'function_call'
      && respAnthToolsCompleted?.response?.output?.[1]?.call_id === 'toolu_1'
      && respAnthToolsCompleted?.response?.output?.[1]?.arguments === '{"city":"Paris"}'
      && respAnthToolsCompleted?.response?.usage?.output_tokens === 5,
    JSON.stringify(respAnthToolsCompleted)?.slice(0, 400),
  );

  // ---- fallback chains ----------------------------------------------------

  const fb500 = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-fb-500', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 fallback: upstream 500 → falls through to mock-chat → 200 (attempts 2)',
    fb500.status === 200 && fb500.body?.choices?.[0]?.message?.content === 'Hello from the mock upstream!'
      && fb500.headers.get('x-khateway-provider') === 'Khateway Mock (smoke)'
      && fb500.headers.get('x-khateway-attempts') === '2',
    JSON.stringify(fb500.body),
  );

  const fb429 = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-fb-429', input: 'hi' }));
  check(
    'M6 fallback: upstream 429 → falls through (responses dialect) → 200 attempts 2',
    fb429.status === 200 && fb429.body?.object === 'response' && fb429.headers.get('x-khateway-attempts') === '2',
    JSON.stringify(fb429.body),
  );

  const fbAnth = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-fb-anthropic', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 fallback: cross-adapter (anthropic 429 → openai provider) → 200 attempts 2',
    fbAnth.status === 200 && fbAnth.body?.type === 'message' && fbAnth.headers.get('x-khateway-attempts') === '2',
    JSON.stringify(fbAnth.body),
  );

  const fbDead = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-fb-dead', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 fallback: dead fallback entry skipped → last upstream 500 surfaced',
    fbDead.status === 500 && fbDead.body?.error?.type === 'api_error' && fbDead.headers.get('x-khateway-attempts') === '1',
    JSON.stringify(fbDead.body),
  );

  const fb401 = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-fb-401', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M6 no fallback on client 4xx: upstream 401 surfaces immediately (attempts 1)',
    fb401.status === 401 && fb401.body?.error?.code === 'invalid_api_key' && fb401.headers.get('x-khateway-attempts') === '1',
    JSON.stringify(fb401.body),
  );

  // -- upstream error mapping ---------------------------------------------
  const rate = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat-429', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'upstream 429 → status kept, type derived rate_limit_error',
    rate.status === 429 && rate.body?.error?.type === 'rate_limit_error' && rate.body?.error?.message === 'Slow down',
    JSON.stringify(rate.body),
  );

  const auth = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat-401', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'upstream 401 → message+code passthrough',
    auth.status === 401 && auth.body?.error?.message === 'Invalid mock API key' && auth.body?.error?.code === 'invalid_api_key',
    JSON.stringify(auth.body),
  );

  const boom = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat-500', messages: [{ role: 'user', content: 'hi' }] }));
  check('upstream 500 json → type api_error', boom.status === 500 && boom.body?.error?.type === 'api_error', JSON.stringify(boom.body));

  const boomText = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat-500t', messages: [{ role: 'user', content: 'hi' }] }));
  check('upstream 500 plain text → envelope wraps text', boomText.status === 500 && boomText.body?.error?.message === 'boom', JSON.stringify(boomText.body));

  // ==================================================================
  // M12: native Gemini adapter — generateContent upstream (incl.
  // thinking budgets + native multiparts) routed through ALL THREE
  // client dialects (openai chat / anthropic messages / responses),
  // JSON and SSE, tools, vision, and Google-envelope error mapping.
  // The OpenAI-compat Gemini endpoint remains available via a plain
  // openai-adapter provider (already covered by the openai cells).
  // ==================================================================

  // -- admin surfaces: test-connection + discovery speak gemini -------------
  const gemTest = await j(`/admin/providers/${provGemini.body.id}/test`, { method: 'POST' });
  check(
    'M12 test-connection probes /v1beta/models with x-goog-api-key',
    gemTest.status === 200 && gemTest.body?.ok === true && gemTest.body?.model_count === 2,
    JSON.stringify(gemTest.body),
  );

  const gemFetched = await j(`/admin/providers/${provGemini.body.id}/fetch-models`, { method: 'POST' });
  const gemFetchedIds = (gemFetched.body?.models ?? []).map((m) => m.id);
  check(
    'M12 fetch-models normalizes the gemini listing (strips models/ prefix, skips non-generateContent)',
    gemFetched.status === 200 && gemFetchedIds.includes('gemini-mock') && !gemFetchedIds.includes('gemini-embedding') && (gemFetched.body?.models ?? []).find((m) => m.id === 'gemini-mock')?.context_window === 1048576,
    JSON.stringify(gemFetched.body),
  );

  const gemPreview = await j('/admin/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ adapters: ['gemini'], base_url: `http://127.0.0.1:${mock.port}/v1beta`, api_key: 'sk-gemini-preview' }),
  });
  check(
    'M12 fetch-models preview probes the gemini /v1beta/models path',
    gemPreview.status === 200 && lastReq.path.endsWith('/v1beta/models') && lastReq.headers['x-goog-api-key'] === 'sk-gemini-preview',
    JSON.stringify({ path: lastReq.path, body: gemPreview.body }),
  );

  // -- openai client → gemini upstream (translated, usage mapped) -----------
  const gemOpenai = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-gemini', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 chat → gemini upstream: translated to openai completion + thoughts folded into usage',
    gemOpenai.status === 200 && gemOpenai.body?.object === 'chat.completion' && gemOpenai.body?.choices?.[0]?.message?.content === 'Hello from native Gemini!' && gemOpenai.body?.choices?.[0]?.finish_reason === 'stop' && gemOpenai.body?.usage?.prompt_tokens === 4 && gemOpenai.body?.usage?.completion_tokens === 8 && gemOpenai.body?.usage?.total_tokens === 12,
    JSON.stringify(gemOpenai.body),
  );
  check(
    'M12 chat → gemini upstream: x-goog-api-key, model in URL path, no body.model/stream',
    lastReq.path.endsWith('/v1beta/models/gemini-mock:generateContent') && lastReq.headers['x-goog-api-key'] === 'sk-gemini-mock' && lastReq.body?.model === undefined && lastReq.body?.stream === undefined && lastReq.body?.contents?.[0]?.role === 'user' && lastReq.body?.contents?.[0]?.parts?.[0]?.text === 'hi',
    `${lastReq.path} ${JSON.stringify(lastReq.body)}`,
  );

  // -- anthropic client → gemini upstream ------------------------------------
  const gemAnth = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-gemini', max_tokens: 256, system: 'Be terse.', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 messages → gemini upstream: translated to anthropic message + mapped usage',
    gemAnth.status === 200 && gemAnth.body?.type === 'message' && gemAnth.body?.content?.[0]?.text === 'Hello from native Gemini!' && gemAnth.body?.stop_reason === 'end_turn' && gemAnth.body?.usage?.input_tokens === 4 && gemAnth.body?.usage?.output_tokens === 8,
    JSON.stringify(gemAnth.body),
  );
  check(
    'M12 messages → gemini upstream: system folds into systemInstruction, max_tokens → maxOutputTokens',
    lastReq.body?.systemInstruction?.parts?.[0]?.text === 'Be terse.' && lastReq.body?.generationConfig?.maxOutputTokens === 256,
    JSON.stringify(lastReq.body),
  );

  // -- responses client → gemini upstream ------------------------------------
  const gemResp = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-gemini', input: 'hi', instructions: 'Be terse.' }));
  check(
    'M12 responses → gemini upstream: translated to a Responses object + mapped usage',
    gemResp.status === 200 && gemResp.body?.object === 'response' && gemResp.body?.status === 'completed' && gemResp.body?.output?.[0]?.content?.[0]?.text === 'Hello from native Gemini!' && gemResp.body?.usage?.input_tokens === 4 && gemResp.body?.usage?.output_tokens === 8,
    JSON.stringify(gemResp.body),
  );

  // -- streaming through all three client faces ------------------------------
  const gemStream = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-gemini', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } }),
  });
  const gemStreamText = await gemStream.text();
  const gemStreamChunks = parseDataLines(gemStreamText);
  const gemStreamText2 = gemStreamChunks.map((ch) => ch?.choices?.[0]?.delta?.content ?? '').join('');
  const gemStreamUsageOnly = gemStreamChunks.find((ch) => Array.isArray(ch?.choices) && ch.choices.length === 0 && ch?.usage?.completion_tokens === 8);
  check(
    'M12 chat stream → gemini upstream: synthesized openai chunks + include_usage usage-only chunk',
    gemStream.status === 200 && (gemStream.headers.get('content-type') ?? '').includes('text/event-stream') && gemStreamText2 === 'Hello from native Gemini!' && !!gemStreamUsageOnly && gemStreamText.trimEnd().endsWith('data: [DONE]'),
    `text=${gemStreamText2} tail=${gemStreamText.slice(-120)}`,
  );
  const gemStreamReq = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-gemini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  check(
    'M12 chat stream → gemini upstream hits :streamGenerateContent?alt=sse',
    gemStreamReq.status === 200 && lastReq.path.endsWith('/v1beta/models/gemini-mock:streamGenerateContent?alt=sse'),
    lastReq.path,
  );

  const gemAnthStream = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-gemini', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const gemAnthStreamText = await gemAnthStream.text();
  const gemAnthText2 = parseSseEvents(gemAnthStreamText, 'content_block_delta').map((e) => e?.delta?.text ?? '').join('');
  const gemAnthUsage = parseSseEvents(gemAnthStreamText, 'message_delta').map((e) => e?.usage?.output_tokens).find((v) => v !== undefined);
  check(
    'M12 messages stream → gemini upstream: Messages events with mapped usage',
    gemAnthStream.status === 200 && gemAnthStreamText.includes('event: message_start') && gemAnthText2 === 'Hello from native Gemini!' && gemAnthUsage === 8 && gemAnthStreamText.includes('event: message_stop'),
    `text=${gemAnthText2} usage=${gemAnthUsage} len=${gemAnthStreamText.length}`,
  );

  const gemRespStream = await fetch(base + '/v1/responses', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-gemini', input: 'hi', stream: true }),
  });
  const gemRespStreamText = await gemRespStream.text();
  const gemRespCompleted = parseSseEvent(gemRespStreamText, 'response.completed');
  check(
    'M12 responses stream → gemini upstream: completed with assembled text + usage',
    gemRespStream.status === 200 && gemRespCompleted?.response?.status === 'completed' && gemRespCompleted?.response?.output?.[0]?.content?.[0]?.text === 'Hello from native Gemini!' && gemRespCompleted?.response?.usage?.input_tokens === 4 && gemRespCompleted?.response?.usage?.output_tokens === 8,
    JSON.stringify(gemRespCompleted)?.slice(0, 300),
  );

  // -- tools: functionCall → tool_calls, tool result → functionResponse ------
  const gemTools = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-gemini-tools', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 chat → gemini upstream functionCall part → tool_calls + finish_reason tool_calls',
    gemTools.status === 200 && gemTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.id === 'call_gemini_0' && gemTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather' && gemTools.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments === '{"city":"Paris"}' && gemTools.body?.choices?.[0]?.finish_reason === 'tool_calls',
    JSON.stringify(gemTools.body),
  );

  const gemToolRoundTrip = await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-gemini',
    messages: [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_gemini_0', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_gemini_0', content: '18C' },
    ],
  }));
  check(
    'M12 tool result → gemini upstream functionResponse bound by name (resolved from the call)',
    gemToolRoundTrip.status === 200 && lastReq.body?.contents?.[2]?.parts?.[0]?.functionResponse?.name === 'get_weather' && lastReq.body?.contents?.[2]?.parts?.[0]?.functionResponse?.response?.result === '18C',
    JSON.stringify(lastReq.body),
  );

  // -- native multiparts: vision + thinking budget ----------------------------
  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-gemini',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: PNG } }] }],
  }));
  check(
    'M12 image data URL → gemini upstream inlineData part (native multipart)',
    lastReq.body?.contents?.[0]?.parts?.[0]?.text === 'What is this?' && lastReq.body?.contents?.[0]?.parts?.[1]?.inlineData?.mimeType === 'image/png' && lastReq.body?.contents?.[0]?.parts?.[1]?.inlineData?.data === 'iVBORw0KGgo=',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/chat/completions', JSON.stringify({
    model: 'mock-gemini',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'low',
  }));
  check(
    'M12 reasoning_effort low → gemini upstream thinkingConfig.thinkingBudget 1024',
    lastReq.body?.generationConfig?.thinkingConfig?.thinkingBudget === 1024,
    JSON.stringify(lastReq.body),
  );

  // -- Google error envelope mapping ------------------------------------------
  const gem400 = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-gemini-400', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 gemini 400 INVALID_ARGUMENT → openai envelope (status kept, status string in code)',
    gem400.status === 400 && gem400.body?.error?.type === 'invalid_request_error' && gem400.body?.error?.message === 'Invalid argument for testing.' && gem400.body?.error?.code === 'INVALID_ARGUMENT',
    JSON.stringify(gem400.body),
  );

  const gem400Anth = await fetchOrPost('/v1/messages', JSON.stringify({ model: 'mock-gemini-400', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 gemini 400 → anthropic envelope (invalid_request_error, message preserved)',
    gem400Anth.status === 400 && gem400Anth.body?.type === 'error' && gem400Anth.body?.error?.type === 'invalid_request_error' && gem400Anth.body?.error?.message === 'Invalid argument for testing.',
    JSON.stringify(gem400Anth.body),
  );

  const gem429 = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-gemini-429', messages: [{ role: 'user', content: 'hi' }] }));
  check(
    'M12 gemini 429 RESOURCE_EXHAUSTED → rate_limit_error (chain-exhausted mapping)',
    gem429.status === 429 && gem429.body?.error?.type === 'rate_limit_error' && gem429.body?.error?.message === 'Resource exhausted.' && gem429.headers.get('x-khateway-attempts') === '1',
    JSON.stringify(gem429.body),
  );

  // ==================================================================
  // M7: client API keys, spend caps, per-key allow-lists, request logs.
  // ==================================================================

  // ==================================================================
  // Keyless-native auth matrix (default mode: enforcement off).
  // ==================================================================

  const modelsNoAuth = await fetch(base + '/v1/models').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check(
    'keyless: GET /v1/models with NO auth header → 200 model list',
    modelsNoAuth.status === 200 && modelsNoAuth.body?.object === 'list' && Array.isArray(modelsNoAuth.body?.data),
    `status=${modelsNoAuth.status} n=${modelsNoAuth.body?.data?.length}`,
  );

  const chatNoAuthStream = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const chatNoAuthText = await chatNoAuthStream.text();
  check(
    'keyless: chat with NO auth header → 200 SSE stream',
    chatNoAuthStream.status === 200 && (chatNoAuthStream.headers.get('content-type') ?? '').includes('text/event-stream') && chatNoAuthText.includes('data: [DONE]') && chatNoAuthText.includes('Hello from the mock'),
    `status=${chatNoAuthStream.status} ct=${chatNoAuthStream.headers.get('content-type')}`,
  );

  const chatBearerAnon = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }), 'anonymous');
  check('keyless: chat with `Authorization: Bearer anonymous` → 200 (sentinel ignored)', chatBearerAnon.status === 200, JSON.stringify(chatBearerAnon.body));

  const msgAnonKey = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'anonymous' },
    body: JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('keyless: /v1/messages with `x-api-key: anonymous` → 200 (sentinel ignored)', msgAnonKey.status === 200, String(msgAnonKey.status));

  const msgBadKeyDefault = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer khat-00000000000000000000000000000000' },
    body: JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check(
    'keyless: invalid khat- key → NOT rejected with 401 (rides anonymously; mock-claude has no fallback so upstream errors surface)',
    msgBadKeyDefault.status !== 401,
    `status=${msgBadKeyDefault.status} code=${msgBadKeyDefault.body?.error?.code ?? msgBadKeyDefault.body?.error?.type}`,
  );

  const xApiKeyRes = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('M7 x-api-key header accepted (Anthropic SDK form)', xApiKeyRes.status === 200, String(xApiKeyRes.status));

  // -- per-key allow-lists + spend caps -------------------------------------
  const restricted = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Restricted (smoke)', allowed_models: ['mock-chat'] }) });
  check(
    'M7 create allow-listed key',
    restricted.status === 201 && restricted.body?.key?.startsWith('khat-') && restricted.body?.allowed_models?.[0] === 'mock-chat',
    JSON.stringify({ ...restricted.body, key: restricted.body?.key?.slice(0, 9) + '…' }),
  );

  const denied = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-claude', messages: [{ role: 'user', content: 'hi' }] }), restricted.body.key);
  check(
    'M7 allow-listed key → other model 403 permission_error / model_not_allowed',
    denied.status === 403 && denied.body?.error?.code === 'model_not_allowed' && denied.body?.error?.type === 'permission_error',
    JSON.stringify(denied.body),
  );

  const permitted = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }), restricted.body.key);
  check('M7 allow-listed key → allowed model 200', permitted.status === 200, JSON.stringify(permitted.body));

  const capped = await j('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Capped (smoke)', spend_limit_usd: 0 }) });
  const cappedReq = await fetchOrPost('/v1/responses', JSON.stringify({ model: 'mock-chat', input: 'hi' }), capped.body.key);
  check(
    'M7 spend-capped key (limit 0) → 429 insufficient_quota / spend_limit_exceeded',
    cappedReq.status === 429 && cappedReq.body?.error?.type === 'insufficient_quota' && cappedReq.body?.error?.code === 'spend_limit_exceeded',
    JSON.stringify(cappedReq.body),
  );

  await j(`/admin/api-keys/${restricted.body.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  const disabledReq = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }), restricted.body.key);
  check(
    'M7 disabled key: enforcement off → rides anonymously (no 401); enforcement on → 401 (pinned above)',
    disabledReq.status === 200,
    String(disabledReq.status),
  );

  // -- request logs ----------------------------------------------------------
  // JSON pairing: usage parsed from the upstream body; no pricing → cost null.
  await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-log-json', messages: [{ role: 'user', content: 'hi' }] }));
  const logJson = await waitForLog({ model: 'mock-log-json' }, (r) => r.status === 200 && r.tokens_in === 3 && r.tokens_out === 5);
  check(
    'M7 log row: JSON pairing captures usage + key + latency (cost null without pricing)',
    !!logJson && logJson.key_name === 'Smoke Key (smoke)' && logJson.dialect === 'chat' && logJson.latency_ms != null && logJson.cost_usd === null,
    JSON.stringify(logJson),
  );

  // Streamed pairing: usage lands only after the stream ends (tee watcher).
  const logStreamRes = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: v1Headers(),
    body: JSON.stringify({ model: 'mock-log-stream', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await logStreamRes.text();
  const logStream = await waitForLog({ model: 'mock-log-stream' }, (r) => r.tokens_in === 7 && r.tokens_out === 11);
  check(
    'M7 log row: streamed usage captured after stream end (7 in / 11 out)',
    !!logStream && logStream.status === 200 && logStream.dialect === 'messages',
    JSON.stringify(logStream),
  );

  // Cost snapshot uses the winning model's pricing: 3 in / 5 out at $2/$8 per 1M.
  const pricedRow = await waitForLog({ model: 'mock-chat', status: '2xx' }, (r) => r.cost_usd != null && r.cost_usd > 0);
  check(
    'M7 log row: cost snapshot from model pricing ($0.000046)',
    !!pricedRow && Math.abs(pricedRow.cost_usd - 0.000046) < 1e-8,
    JSON.stringify(pricedRow?.cost_usd),
  );

  // M12: gemini log row — usage mapped from usageMetadata (4 in / 8 out incl.
  // thoughts) and priced 4×2 + 8×8 µ$ = $0.000072.
  const geminiLog = await waitForLog({ model: 'mock-gemini' }, (r) => r.status === 200 && r.tokens_in === 4 && r.tokens_out === 8);
  check(
    'M12 log row: gemini usage 4/8 (thoughts folded in) + priced cost $0.000072',
    !!geminiLog && geminiLog.dialect === 'chat' && Math.abs(geminiLog.cost_usd - 0.000072) < 1e-9,
    JSON.stringify(geminiLog),
  );

  // ==================================================================
  // M13 embeddings: POST /v1/embeddings — openai face (passthrough +
  // JSON usage watcher), native gemini face (normalized response),
  // fallback chain, anthropic-only 501, logs + input-only cost.
  // ==================================================================

  const embSingle = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-emb', input: 'hello world' }));
  check(
    'M13: openai face — single input echoes the list shape + model + usage',
    embSingle.status === 200 &&
      embSingle.body?.object === 'list' &&
      embSingle.body?.data?.[0]?.object === 'embedding' &&
      embSingle.body?.data?.[0]?.index === 0 &&
      embSingle.body?.model === 'mock-emb' &&
      embSingle.body?.usage?.prompt_tokens === 3,
    JSON.stringify(embSingle.body),
  );
  check(
    'M13: openai upstream hit /v1/embeddings with the upstream model name',
    lastReq.path.endsWith('/embeddings') && lastReq.body?.model === 'mock-emb' && lastReq.body?.input?.[0] === 'hello world',
    JSON.stringify(lastReq.body),
  );

  await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-emb', input: 'hello world', dimensions: 256 }));
  check('M13: dimensions forwarded verbatim to the openai upstream', lastReq.body?.dimensions === 256, JSON.stringify(lastReq.body));

  // Log row: tokens + input-only cost (3 tokens × $2/1M = $0.000006).
  const embLog = await waitForLog({ model: 'mock-emb' }, (r) => r.dialect === 'embeddings' && r.tokens_in === 3);
  check(
    'M13 log row: embeddings dialect + 3 in / no output tokens + cost $0.000006',
    !!embLog && embLog.tokens_out === null && embLog.status === 200 && Math.abs(embLog.cost_usd - 0.000006) < 1e-9,
    JSON.stringify(embLog),
  );

  // Array input: two entries → two indexed embeddings, 6 tokens logged.
  const embArray = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-emb', input: ['alpha', 'beta'] }));
  const embArrayLog = await waitForLog({ model: 'mock-emb' }, (r) => r.tokens_in === 6);
  check(
    'M13: array input → indexed embeddings + usage 6 tokens logged',
    embArray.status === 200 && embArray.body?.data?.length === 2 && embArray.body?.data?.[1]?.index === 1 && !!embArrayLog && Math.abs(embArrayLog.cost_usd - 0.000012) < 1e-9,
    JSON.stringify({ count: embArray.body?.data?.length, log: embArrayLog }),
  );

  // Native gemini: single text → :embedContent, normalized onto the openai shape.
  const gemEmb = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-gem-emb', input: 'embed me' }));
  check(
    'M13: native gemini — :embedContent normalized onto the openai list shape',
    gemEmb.status === 200 && gemEmb.body?.object === 'list' && gemEmb.body?.data?.[0]?.embedding?.[0] === 0.125 && gemEmb.body?.model === 'mock-gem-emb' && gemEmb.body?.usage?.prompt_tokens === 3,
    JSON.stringify(gemEmb.body),
  );
  check(
    'M13: gemini upstream hit :embedContent with models/{id} as body.model',
    lastReq.path.endsWith(':embedContent') && lastReq.body?.model === 'models/gem-emb-mock',
    JSON.stringify(lastReq.body),
  );
  const gemEmbLog = await waitForLog({ model: 'mock-gem-emb' }, (r) => r.tokens_in === 3);
  check(
    'M13 log row: gemini usageMetadata → tokens + cost $0.000006',
    !!gemEmbLog && gemEmbLog.dialect === 'embeddings' && Math.abs(gemEmbLog.cost_usd - 0.000006) < 1e-9,
    JSON.stringify(gemEmbLog),
  );

  // Native gemini: several texts → :batchEmbedContents, embeddings in order.
  const gemEmbBatch = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-gem-emb', input: ['a', 'b'] }));
  check(
    'M13: native gemini batch — :batchEmbedContents + two normalized embeddings',
    gemEmbBatch.status === 200 && gemEmbBatch.body?.data?.length === 2 && gemEmbBatch.body?.data?.[1]?.index === 1 && lastReq.path.endsWith(':batchEmbedContents') && lastReq.body?.requests?.length === 2,
    JSON.stringify(lastReq.body),
  );

  // base64 encoding_format against the gemini upstream: Khateway packs the
  // floats client-side (little-endian float32 → base64).
  const gemEmbB64 = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-gem-emb', input: 'b64', encoding_format: 'base64' }));
  const b64 = gemEmbB64.body?.data?.[0]?.embedding;
  const decodedFloats = typeof b64 === 'string' ? Buffer.from(b64, 'base64').length / 4 : 0;
  check(
    'M13: encoding_format base64 → packed float32 (12 bytes = 3 floats)',
    typeof b64 === 'string' && decodedFloats === 3,
    JSON.stringify({ embedding: b64 }),
  );

  // Fallback chain: 429 on the primary embeddings upstream → fallback serves.
  const embFb = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-emb-fb', input: 'retry me' }));
  check(
    'M13: embeddings fallback chain — 429 primary → fallback serves, attempts=2',
    embFb.status === 200 && embFb.headers?.get('x-khateway-attempts') === '2' && embFb.body?.usage?.prompt_tokens === 3,
    JSON.stringify({ status: embFb.status, attempts: embFb.headers?.get('x-khateway-attempts') }),
  );

  // Anthropic-only provider: no embeddings endpoint → 501 (logged).
  const embAnthropic = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'mock-emb-anthropic', input: 'x' }));
  check(
    'M13: anthropic-only provider → 501 upstream_dialect_unsupported (openai envelope)',
    embAnthropic.status === 501 && embAnthropic.body?.error?.code === 'upstream_dialect_unsupported',
    JSON.stringify(embAnthropic.body),
  );
  const embAnthropicLog = await waitForLog({ model: 'mock-emb-anthropic' }, (r) => r.status === 501);
  check('M13 log row: 501 logged with the embeddings dialect', !!embAnthropicLog && embAnthropicLog.dialect === 'embeddings', JSON.stringify(embAnthropicLog));

  // Unknown model → openai 404, logged like chat.
  const embUnknown = await fetchOrPost('/v1/embeddings', JSON.stringify({ model: 'zzz-not-real', input: 'x' }));
  check('M13: unknown embeddings model → 404 model_not_found', unknownModelOk(embUnknown), JSON.stringify(embUnknown.body));

  // Upstream failures are logged with status + error text.
  const errRow = await waitForLog({ model: 'mock-chat-429' }, (r) => r.status === 429 && (r.error ?? '').includes('Slow down'));
  check('M7 log row: upstream 429 logged with error text', !!errRow, JSON.stringify(errRow));

  const notFoundRow = await waitForLog({ model: 'zzz-not-real' }, (r) => r.status === 404 && r.dialect === 'chat');
  check('M7 log row: unknown model 404 logged', !!notFoundRow, JSON.stringify(notFoundRow));

  // -- key usage stats -------------------------------------------------------
  const keysNow = await j('/admin/api-keys');
  const smokeKey = (keysNow.body ?? []).find((k) => k.name === 'Smoke Key (smoke)');
  check(
    'M7 key stats: last_used_at + request_count reflect gateway traffic',
    !!smokeKey && smokeKey.last_used_at != null && smokeKey.request_count > 0,
    JSON.stringify(smokeKey),
  );

  // -- log filters + clear -----------------------------------------------------
  const err4xx = await j('/admin/logs?status=4xx&limit=500');
  check(
    'M7 logs filter status=4xx → only 4xx rows',
    Array.isArray(err4xx.body) && err4xx.body.length > 0 && err4xx.body.every((r) => r.status >= 400 && r.status < 500),
    `count=${err4xx.body?.length}`,
  );
  const byKey = await j(`/admin/logs?api_key_id=${restricted.body.id}`);
  check(
    'M7 logs filter by key → only that key’s rows',
    Array.isArray(byKey.body) && byKey.body.length > 0 && byKey.body.every((r) => r.api_key_id === restricted.body.id),
    JSON.stringify(byKey.body?.[0]),
  );

  const cleared = await j('/admin/logs', { method: 'DELETE' });
  const afterClear = await j('/admin/logs');
  check('M7 DELETE /admin/logs clears every row', cleared.status === 200 && Array.isArray(afterClear.body) && afterClear.body.length === 0, `after=${afterClear.body?.length}`);

  // ==================================================================
  // Enforcement mode: flip client_key_enforcement on, verify the strict
  // M7 behavior, flip it back off (default) for a clean end state.
  // ==================================================================

  const enforceOn = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ client_key_enforcement: 'on' }) });
  check('PATCH /admin/settings on → enforcement enabled', enforceOn.status === 200 && enforceOn.body?.client_key_enforcement === 'on', JSON.stringify(enforceOn.body));
  // The enforcement flag is TTL-cached in the worker isolate (5 s); wait it out
  // so the toggle is guaranteed visible regardless of isolate pooling.
  await new Promise((r) => setTimeout(r, 5300));

  const modelsEnforced = await fetch(base + '/v1/models').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check(
    'enforced: /v1/models without key → 401 invalid_api_key',
    modelsEnforced.status === 401 && modelsEnforced.body?.error?.code === 'invalid_api_key' && modelsEnforced.body?.error?.type === 'authentication_error',
    JSON.stringify(modelsEnforced.body),
  );

  const chatAnonEnforced = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }), 'anonymous');
  check(
    'enforced: Bearer anonymous → 401 (sentinel never validated against keys)',
    chatAnonEnforced.status === 401 && chatAnonEnforced.body?.error?.code === 'invalid_api_key',
    JSON.stringify(chatAnonEnforced.body),
  );

  const msgBadKeyEnforced = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer khat-00000000000000000000000000000000' },
    body: JSON.stringify({ model: 'mock-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check(
    'enforced: invalid khat- key → 401 anthropic envelope (authentication_error)',
    msgBadKeyEnforced.status === 401 && msgBadKeyEnforced.body?.type === 'error' && msgBadKeyEnforced.body?.error?.type === 'authentication_error',
    JSON.stringify(msgBadKeyEnforced.body),
  );

  const chatValidEnforced = await fetchOrPost('/v1/chat/completions', JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }));
  check('enforced: valid khat- key still works → 200', chatValidEnforced.status === 200, String(chatValidEnforced.status));

  const enforceOff = await j('/admin/settings', { method: 'PATCH', body: JSON.stringify({ client_key_enforcement: 'off' }) });
  check('PATCH /admin/settings off → back to keyless default', enforceOff.status === 200 && enforceOff.body?.client_key_enforcement === 'off', JSON.stringify(enforceOff.body));
  await new Promise((r) => setTimeout(r, 5300)); // TTL convergence (see above)

  const chatKeylessAgain = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hi' }] }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  check('keyless again after toggle-back: no-auth chat → 200', chatKeylessAgain.status === 200, String(chatKeylessAgain.status));

  // -- unknown /v1 endpoint -------------------------------------------------
  const unknownEndpoint = await fetchOrPost('/v1/zzz', null);
  check('unknown /v1 endpoint → 404 openai envelope', unknownEndpoint.status === 404 && unknownEndpoint.body?.error?.type === 'invalid_request_error', JSON.stringify(unknownEndpoint.body));
})()
  .catch((e) => {
    fail('smoke crashed', String(e));
  })
  .finally(async () => {
    await cleanup();
    await mock.close();
    console.log(`\n${passes.length} passed, ${failures} failed`);
    if (failures > 0) process.exitCode = 1;
  });

function fetchOrPost(path, rawBody, keyOverride) {
  return fetch(base + path, {
    method: rawBody === null ? 'GET' : 'POST',
    headers: { ...v1Headers(), ...(keyOverride ? { authorization: `Bearer ${keyOverride}` } : {}) },
    body: rawBody,
  }).then(async (res) => {
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, body };
  });
}

function unknownModelOk(r) {
  return r.status === 404 && r.body?.error?.code === 'model_not_found';
}

/** Polls /admin/logs until a row matching `predicate` appears (streamed usage lands asynchronously). */
async function waitForLog(filter, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  const qs = new URLSearchParams(filter);
  while (Date.now() < deadline) {
    const res = await j(`/admin/logs?${qs}`);
    const hit = (res.body ?? []).find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Extracts the JSON data payload of the first SSE event with the given name. */
function parseSseEvent(text, eventName) {
  const m = text.match(new RegExp(`event: ${eventName}\\ndata: (.*)`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Extracts the JSON payloads of ALL SSE events with the given name. */
function parseSseEvents(text, eventName) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`event: ${eventName}\\ndata: (.*)`, 'g'))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Extracts the JSON payloads of all `data:` lines (openai chunk streams; `[DONE]` skipped). */
function parseDataLines(text) {
  const out = [];
  for (const m of text.matchAll(/^data: (.*)$/gm)) {
    if (m[1] === '[DONE]') continue;
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // skip malformed
    }
  }
  return out;
}
