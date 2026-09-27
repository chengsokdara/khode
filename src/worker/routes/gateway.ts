// /v1 gateway: the live inference surface. M3 shipped POST /v1/chat/completions
// (SSE passthrough) and GET /v1/models(+/:id); M4 added POST /v1/messages and
// the cross-dialect translation matrix; M5 added POST /v1/responses as the
// third client dialect — any client dialect (openai chat, anthropic messages,
// openai responses) to any upstream adapter (openai-compatible, anthropic),
// with responses/SSE translated back into the caller's dialect. M6 adds
// tools/vision translation end-to-end and the fallback-chain retry loop:
// every chat pipeline walks the model's ordered fallback chain (models.fallbacks)
// on 429/5xx/timeout/network outcomes. Same-dialect pairings relay response
// bodies untouched (there is no responses upstream adapter, so every
// /v1/responses pairing is translated). Providers declare the upstream
// dialects they speak (providers.adapters JSON array): dual-dialect endpoints
// (OpenRouter, LiteLLM, AI Gateway, …) are ONE provider whose adapter is
// picked per request (client-dialect match first) and swapped on translation
// failure before any fallback is consumed. M7 completes the surface: every /v1/*
// request authenticates with a client API key (`Authorization: Bearer khat-…`,
// sha-256 lookup), spend caps + per-key allowed-model lists are enforced, and
// every chat-pipeline request writes a request_logs row (status, latency,
// tokens, cost snapshot) — streamed responses tee their upstream body so usage
// is captured without disturbing the client stream.
//
// KEY REQUIREMENT (session 29 — the keyless-native era is over): every /v1
// request must carry a valid enabled client key (`Authorization: Bearer
// khat-…` or `x-api-key`); anything else gets a 401 in the path's dialect.
// Onboarding is the device flow (/api/v1/device → a personal portal key) or
// keys from the portal/admin console. The old keyless-native default, the
// official-build gate (x-khateway-access) and the guest pool were removed
// together — device sign-in replaced them all.
//
// M10 rate limiting: after routing resolves the model, every chat-pipeline
// request increments fixed 1-minute counters in the RateLimiterDO (cross-
// isolate): per-key (or per-IP for anonymous) + the model's optional global
// cap — 429 + Retry-After in the caller's dialect when a bucket overflows,
// fail-open if the limiter itself errors. Config: settings rows
// (rate_limit_enabled/key_rpm/ip_rpm) + models.rate_limit_rpm +
// api_keys.rate_limit_rpm overrides.
//
// M11 semantic cache: eligible text-only, non-streaming requests on a
// cache-opted model (or cache-opted client key) are served from the
// `cache_entries` table when the sha-256 of their canonical request + model
// slug was stored recently. Hits replay the stored upstream payload through
// the exact same passthrough/translation path a miss would take, log with
// cache_hit=1 and bill/debit like any response; misses store their raw
// upstream JSON in waitUntil. All gates (spend cap, rate limits, allow-list,
// balance) run BEFORE the lookup — a cache hit never bypasses billing.
//
// M13 embeddings: POST /v1/embeddings is the first non-chat pipeline branch.
// It speaks the OpenAI Embeddings API (the only embeddings client face —
// Anthropic has none) and shares the auth middleware, gates, fallback-chain
// walk, logging and balance debits with the chat pipeline. Upstreams:
// openai-compatible `/embeddings` (passthrough + JSON usage watcher) and
// native Gemini `:embedContent`/`:batchEmbedContents` (normalized onto the
// openai response shape). No streaming, no translation matrix, no semantic
// cache; anthropic-only providers answer 501.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { and, asc, eq, sql, sum } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import type { CanonicalChatRequest, CanonicalEmbeddingsRequest } from '../canonical';
import { apiKeys, balanceEntries, models, orgs, providers, requestLogs, users } from '../db/schema';
import { resolveModelChain, type RoutingCandidate } from '../routing';
import { verifyClientKey, type ApiKeyRow } from '../auth';
import { getCacheSettings, getRateLimitSettings } from '../db/settings';
import { buildGatewayRateChecks, checkRateLimits, reserveSpend, settleSpend } from '../ratelimit/client';
import type { RateLimitDecision } from '../ratelimit/do';
import { buildCacheKey, evaluateCacheEligibility } from '../cache/key';
import { lookupCacheEntry, storeCacheEntry } from '../cache/store';
import { invokeUpstream, UpstreamMisconfigError, UnsupportedTranslationError, type UpstreamOutcome, type UpstreamRequest } from '../adapters/base';
import { retryDecision, sleep } from '../backoff';
import { buildOpenAiChatRequest, buildOpenAiEmbeddingsRequest } from '../adapters/openai';
import { buildAnthropicMessagesRequest } from '../adapters/anthropic';
import { buildGeminiEmbeddingsRequest, buildGeminiGenerateContentRequest } from '../adapters/gemini';
import { costUsd, usageFromJsonBody, watchUpstreamJsonUsage, watchUpstreamSseUsage, type TokenUsage } from '../dialects/usage';
import { geminiCompletionToOpenAi, geminiEmbeddingsToOpenAi, geminiErrorToOpenAi, transformGeminiSseToOpenAi } from '../dialects/gemini';
import { parseOpenAiEmbeddingsRequest } from '../dialects/openaiEmbeddings';
import { anthropicStructuredOutputTool } from '../dialects/options';
import {
  completionFromChatCompletion,
  parseOpenAiCompletionsRequest,
  transformChatSseToTextCompletionSse,
} from '../dialects/openaiCompletions';
import { withSseKeepAlive } from '../dialects/sse';
import {
  anthropicMessageToOpenAiCompletion,
  openAiError,
  parseOpenAiChatRequest,
  transformAnthropicSseToOpenAi,
  upstreamErrorToOpenAi,
  type OpenAiErrorBody,
} from '../dialects/openaiChat';
import {
  anthropicError,
  openAiCompletionToAnthropicMessage,
  parseAnthropicMessagesRequest,
  transformOpenAiSseToAnthropic,
  upstreamErrorToAnthropic,
  type AnthropicErrorBody,
} from '../dialects/anthropicMessages';
import {
  anthropicMessageToResponse,
  openAiCompletionToResponse,
  parseOpenAiResponsesRequest,
  transformAnthropicSseToResponses,
  transformOpenAiSseToResponses,
} from '../dialects/openaiResponses';

type GatewayEnv = { Bindings: Env; Variables: { clientKey: ApiKeyRow | null } };
type ClientDialect = 'openai' | 'anthropic' | 'responses';
/** Upstream adapters (M12 adds native Gemini — never a client-facing dialect). */
type UpstreamAdapter = 'openai' | 'anthropic' | 'gemini';

export const gatewayApp = new Hono<GatewayEnv>();

// Model routers get called from browser SDKs too — permissive CORS on /v1.
gatewayApp.use('*', cors());

// ------------------------------------------------------------ client keys

/**
 * M7 gateway auth, strict since session 29 (the keyless-native era is over):
 * EVERY request must carry a valid enabled client key — `Authorization:
 * Bearer khat-…` (OpenAI SDKs) or `x-api-key` (Anthropic SDKs), both
 * accepted so SDKs stay drop-in (M4 promise). Anything else — no header,
 * the old `anonymous` sentinel, unknown or disabled tokens — gets a 401 in
 * the path's dialect. Clients onboard through the device flow
 * (/api/v1/device → a personal portal key) or a key from the portal/admin
 * console. Keys that verify get spend caps, allow-lists, log attribution
 * and their balance gates (M8/M9).
 *
 * CORS preflights are answered by the cors() middleware above and never
 * reach this point.
 */
function clientDialectForPath(path: string): ClientDialect {
  return path.endsWith('/messages') ? 'anthropic' : 'openai';
}

/** The sentinel value keyless clients send instead of a real key. */
const ANONYMOUS_KEY = 'anonymous';

/** Header carrying the keyless-gate access secret (official khode builds). */
const KEYLESS_ACCESS_HEADER = 'x-khateway-access';

gatewayApp.use('*', async (c, next) => {
  const dialect = clientDialectForPath(c.req.path);
  // OpenAI SDKs send `Authorization: Bearer <key>`; the Anthropic SDK sends
  // `x-api-key: <key>` — both are accepted so SDKs stay drop-in (M4 promise).
  const bearer = c.req.header('authorization') ?? '';
  const raw = (bearer.startsWith('Bearer ') ? bearer.slice(7) : '').trim() || (c.req.header('x-api-key') ?? '').trim();
  const lookup = raw ? await verifyClientKey(c.env, raw) : null;
  const key = lookup && lookup.enabled ? lookup : null;

  if (!key) {
    return errorJson(
      dialect,
      401,
      dialectError(dialect, 401, 'Invalid or disabled API key — sign in from your client (khode: /login) or create a key in the Khateway portal / admin console.', {
        code: 'invalid_api_key',
        type: 'authentication_error',
      }),
    );
  }

  c.set('clientKey', key);
  // Opportunistic last-used stamp; must never block or fail the request.
  try {
    await getDb(c.env).update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, key.id));
  } catch {
    // ignore
  }
    await next();
});

gatewayApp.get('/', (c) =>
  c.json({
    service: 'khateway',
    endpoints: ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages', '/v1/embeddings', '/v1/models', '/v1/models/{id}'],
  }),
);

// ------------------------------------------------------------------ models

/**
 * USD-per-1M pricing → OpenRouter-style per-token decimal string. toFixed(12)
 * + trailing-zero trim avoids exponent notation (0.15/1e6 must render as
 * "0.00000015", not "1.5e-7" — clients parse these).
 */
function usdPerMillionToPerToken(price: number | null | undefined): string | null {
  if (price == null || !Number.isFinite(price) || price < 0) return null;
  if (price === 0) return '0';
  let s = (price / 1e6).toFixed(12);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s;
}

/** What each upstream adapter can express end-to-end (M16 client parity —
 * served as `supported_parameters` on /v1/models). Conservative: only params
 * the gateway actually forwards or translates for that adapter. */
const ADAPTER_SUPPORTED_PARAMS: Record<UpstreamAdapter, string[]> = {
  openai: [
    'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'stream', 'stream_options',
    'n', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'seed',
    'presence_penalty', 'frequency_penalty', 'logprobs', 'logit_bias',
  ],
  anthropic: ['temperature', 'top_p', 'top_k', 'max_tokens', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'response_format', 'metadata', 'cache_control'],
  gemini: ['temperature', 'top_p', 'top_k', 'max_tokens', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'reasoning_effort', 'response_format'],
};

/** Parses providers.adapters JSON defensively (shared with routing's parser contract). */
function parseProviderAdapters(json: string | null): UpstreamAdapter[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is UpstreamAdapter => x === 'openai' || x === 'anthropic' || x === 'gemini');
  } catch {
    return [];
  }
}

function supportedParametersFor(providerAdapters: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of parseProviderAdapters(providerAdapters)) {
    for (const p of ADAPTER_SUPPORTED_PARAMS[a]) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

function modelListDto(r: {
  slug: string;
  upstreamModel: string | null;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricingInput: number | null;
  pricingOutput: number | null;
  createdAt: number;
  providerName: string;
  providerAdapters: string | null;
}) {
  const prompt = usdPerMillionToPerToken(r.pricingInput);
  const completion = usdPerMillionToPerToken(r.pricingOutput);
  return {
    id: r.slug,
    object: 'model',
    created: Math.floor(r.createdAt / 1000),
    owned_by: r.providerName,
    display_name: r.displayName,
    upstream_model: r.upstreamModel || r.slug,
    context_window: r.contextWindow,
    max_output_tokens: r.maxOutputTokens,
    // M16 OpenRouter parity: per-token pricing strings (unknown ≠ free — null
    // when no pricing is set, members null when one side is unset).
    pricing: prompt == null && completion == null ? null : { prompt, completion },
    supported_parameters: supportedParametersFor(r.providerAdapters),
  };
}

const listFields = {
  slug: models.slug,
  upstreamModel: models.upstreamModel,
  displayName: models.displayName,
  contextWindow: models.contextWindow,
  maxOutputTokens: models.maxOutputTokens,
  pricingInput: models.pricingInput,
  pricingOutput: models.pricingOutput,
  createdAt: models.createdAt,
  providerName: providers.name,
  providerAdapters: providers.adapters,
};

gatewayApp.get('/models', async (c) => {
  const rows = await getDb(c.env)
    .select(listFields)
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true)))
    .orderBy(asc(models.slug));
  return c.json({ object: 'list', data: rows.map((r) => modelListDto(r)) });
});

gatewayApp.get('/models/:id', async (c) => {
  const slug = c.req.param('id');
  const [row] = await getDb(c.env)
    .select(listFields)
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.slug, slug), eq(models.enabled, true), eq(providers.enabled, true)));
  if (!row) {
    return errorJson('openai', 404, openAiError(404, `The model '${slug}' does not exist or you do not have access to it.`, { code: 'model_not_found' }));
  }
  return c.json(modelListDto(row));
});

// ------------------------------------------------------------- chat matrix

function errorJson(
  dialect: ClientDialect,
  status: number,
  body: OpenAiErrorBody | AnthropicErrorBody,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, 'content-type': 'application/json' },
  });
}

/** Renders `message` as an error body in the caller's dialect. */
function dialectError(
  dialect: ClientDialect,
  status: number,
  message: string,
  opts: { param?: string | null; code?: string | null; type?: string } = {},
): OpenAiErrorBody | AnthropicErrorBody {
  return dialect === 'anthropic' ? anthropicError(status, message, { type: opts.type }) : openAiError(status, message, opts);
}

interface ChatMeta {
  requested: string;
  candidate: RoutingCandidate;
  latencyMs: number;
  dialect: ClientDialect;
  upstream: UpstreamAdapter;
  /** 1-based position across the whole chain: primary model, its second adapter, fallbacks… */
  attempts: number;
  /** Client asked for openai stream_options.include_usage (openai chat dialect only). */
  streamIncludeUsage?: boolean;
  /** M18: structured-output emulation active on an anthropic upstream — the translators unwrap the synthetic tool's tool_use block into content. */
  structuredOutput?: boolean;
  /** M11: set only when the request was cache-eligible (header reporting). */
  cacheState?: 'hit' | 'miss';
  /** M16: OpenAI-style success-path x-ratelimit-* headers from the binding bucket. */
  rateHeaders?: Record<string, string> | null;
}

/**
 * Picks the upstream adapter to try first for a client dialect. Matching the
 * client's dialect keeps the same-dialect passthrough path (no translation);
 * otherwise the provider's FIRST declared adapter wins (its preference order —
 * e.g. a [gemini, openai] provider serves anthropic/responses clients through
 * the native gemini adapter, translated). The remaining supported adapters
 * become same-candidate retries when the first pick cannot express the
 * request (see the build loop below).
 */
function preferredAdapter(dialect: ClientDialect, usable: UpstreamAdapter[]): UpstreamAdapter {
  if (dialect === 'anthropic' && usable.includes('anthropic')) return 'anthropic';
  if (dialect !== 'anthropic' && usable.includes('openai')) return 'openai';
  return usable[0];
}

/**
 * Maps an upstream failure response into the caller's error envelope,
 * preserving the upstream HTTP status. Gemini's Google error vocabulary
 * ({"error":{code,message,status}}) is normalized first, then re-rendered in
 * the client's dialect (the anthropic mapper consumes the openai-shaped body).
 */
function upstreamErrorBody(
  dialect: ClientDialect,
  upstream: UpstreamAdapter,
  status: number,
  raw: string,
): OpenAiErrorBody | AnthropicErrorBody {
  if (upstream === 'gemini') {
    const openai = geminiErrorToOpenAi(status, raw);
    return dialect === 'anthropic' ? upstreamErrorToAnthropic(status, JSON.stringify(openai)) : openai;
  }
  return dialect === 'anthropic' ? upstreamErrorToAnthropic(status, raw) : upstreamErrorToOpenAi(status, raw);
}

// --------------------------------------------------------- request logging

const ERROR_MAX = 300;

/** Parses the api_keys.allowed_models JSON column defensively. */
function parseAllowedModels(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

function truncateError(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > ERROR_MAX ? `${t.slice(0, ERROR_MAX)}…` : t;
}

/**
 * Per-request log draft: filled in as the pipeline settles on an outcome, then
 * persisted by runChatPipeline. `usageWatch` carries a tee()'d branch of the
 * upstream stream on SSE paths so token usage lands in the row after the
 * client-facing response has already been returned.
 */
interface LogDraft {
  apiKeyId: string | null;
  /** Owning portal account (M8) — the key's user (owner for personal keys,
   * creator for org keys, M9). Its prepaid balance is debited for personal keys. */
  userId: string | null;
  /** Owning org (M9) for org-scoped keys — org keys debit the org balance. */
  orgId: string | null;
  /** request_logs.dialect vocabulary (see LOG_DIALECT). */
  dialect: 'chat' | 'responses' | 'messages' | 'embeddings' | 'completions';
  modelSlug: string;
  providerId: string | null;
  upstreamModel: string | null;
  usage: TokenUsage | null;
  pricingInput: number | null;
  pricingOutput: number | null;
  /** Tee'd upstream stream branch to watch after the response is returned. */
  usageWatch: { upstream: UpstreamAdapter; stream: ReadableStream<Uint8Array>; sse: boolean } | null;
  /** M11: response came from the semantic cache (no upstream call). */
  cacheHit: boolean;
  error: string | null;
  /** M16 client attribution: OpenRouter-style HTTP-Referer / X-Title headers. */
  httpReferer: string | null;
  xTitle: string | null;
  /** P4: the in-flight spend reservation parked in the DO while this request
   * runs (capped keys only); released in writeRequestLog once the log row (and
   * for streams, the final usage) is in. Absent = nothing reserved. */
  spendReservation?: { scope: string; micros: number } | null;
}

/** request_logs.dialect vocabulary (schema contract): chat | responses | messages | embeddings. */
const LOG_DIALECT: Record<ClientDialect, 'chat' | 'responses' | 'messages'> = {
  openai: 'chat',
  responses: 'responses',
  anthropic: 'messages',
};

/** M16 client attribution — OpenRouter-style app headers (never auth headers). */
function attributionFrom(c: Context<GatewayEnv>): { httpReferer: string | null; xTitle: string | null } {
  const ref = c.req.header('http-referer')?.trim();
  const title = c.req.header('x-title')?.trim();
  // Bound the stored length — a referer URL is metadata, not free storage.
  return { httpReferer: ref ? ref.slice(0, 300) : null, xTitle: title ? title.slice(0, 120) : null };
}

/**
 * Debits a request's cost from the prepaid balance behind the key (M8 personal
 * accounts, M9 orgs): exactly one of userId/orgId is set. The ledger row's
 * `ref` (log:<id>) is unique so the same request can never be debited twice;
 * the balance update rides in the same D1 batch. Soft like the spend cap: the
 * pre-flight gate means concurrent requests can push the balance slightly
 * negative. Unknown cost (null pricing, missing usage) never debits.
 */
async function debitBalanceUsage(
  env: Env,
  target: { userId: string | null; orgId: string | null },
  logId: string,
  cost: number | null,
): Promise<void> {
  if (cost == null) return;
  const micros = Math.round(cost * 1e6);
  if (micros <= 0) return;
  const db = getDb(env);
  try {
    await db.batch([
      db.insert(balanceEntries).values({
        id: crypto.randomUUID(),
        userId: target.orgId ? null : target.userId,
        orgId: target.orgId ?? null,
        deltaUsdMicros: -micros,
        kind: 'usage',
        ref: `log:${logId}`,
        createdAt: Date.now(),
      }),
      target.orgId
        ? db
            .update(orgs)
            .set({ balanceUsdMicros: sql`${orgs.balanceUsdMicros} - ${micros}`, updatedAt: Date.now() })
            .where(eq(orgs.id, target.orgId))
        : db
            .update(users)
            .set({ balanceUsdMicros: sql`${users.balanceUsdMicros} - ${micros}`, updatedAt: Date.now() })
            .where(eq(users.id, target.userId!)),
    ]);
  } catch (e) {
    console.error('[gateway] balance debit failed:', e);
  }
}

async function writeRequestLog(
  env: Env,
  draft: LogDraft,
  res: Response,
  latencyMs: number,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const id = crypto.randomUUID();
  const cost = costUsd(draft.pricingInput, draft.pricingOutput, draft.usage);
  try {
    await getDb(env).insert(requestLogs).values({
      id,
      apiKeyId: draft.apiKeyId,
      userId: draft.userId,
      orgId: draft.orgId,
      modelSlug: draft.modelSlug || '(unknown)',
      providerId: draft.providerId,
      upstreamModel: draft.upstreamModel,
      dialect: draft.dialect,
      status: res.status,
      latencyMs,
      tokensIn: draft.usage?.tokensIn ?? null,
      tokensOut: draft.usage?.tokensOut ?? null,
      costUsd: cost,
      cacheHit: draft.cacheHit,
      httpReferer: draft.httpReferer,
      xTitle: draft.xTitle,
      error: draft.error ? truncateError(draft.error) : null,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.error('[gateway] failed to write request log:', e);
    return;
  }
  // P4: the reservation is released once the log row exists — for streams
  // only after the final usage lands (the real cost then speaks via the SUM).
  const releaseReservation = async (): Promise<void> => {
    const r = draft.spendReservation;
    if (!r) return;
    draft.spendReservation = null;
    await settleSpend(env, r.scope, r.micros);
  };
  if (draft.usageWatch) {
    const { upstream, stream, sse } = draft.usageWatch;
    const pending = sse ? watchUpstreamSseUsage(upstream, stream) : watchUpstreamJsonUsage(upstream, stream);
    waitUntil(
      pending
        .then(async (u) => {
          if (!u || (u.tokensIn === null && u.tokensOut === null)) {
            await releaseReservation();
            return;
          }
          const finalCost = costUsd(draft.pricingInput, draft.pricingOutput, u);
          await getDb(env)
            .update(requestLogs)
            .set({ tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: finalCost })
            .where(eq(requestLogs.id, id));
          if (draft.userId || draft.orgId) await debitBalanceUsage(env, draft, id, finalCost);
          await releaseReservation();
        })
        .catch(async (e) => {
          console.error('[gateway] usage watch failed:', e);
          await releaseReservation(); // never leak the reservation on a watch error
        }),
    );
  } else {
    await releaseReservation();
    if (draft.userId || draft.orgId) {
      // Non-stream path: usage is already final — debit off the hot path.
      waitUntil(debitBalanceUsage(env, draft, id, cost));
    }
  }
}

function khatewayHeaders(meta: ChatMeta): Record<string, string> {
  const headers = {
    'x-khateway-model': meta.requested,
    'x-khateway-provider': meta.candidate.provider.name,
    'x-khateway-upstream-model': meta.candidate.model.upstreamModel,
    'x-khateway-attempts': String(meta.attempts),
    'x-khateway-latency-ms': String(meta.latencyMs),
    ...(meta.rateHeaders ?? {}),
  };
  // Only cache-eligible requests advertise cache state (HIT/MISS); everyone
  // else sees no header rather than a meaningless MISS.
  return meta.cacheState ? { ...headers, 'x-khateway-cache': meta.cacheState.toUpperCase() } : headers;
}

/** Same-dialect pairing: relays the upstream response (JSON or SSE) untouched. */
function passthrough(res: Response, meta: ChatMeta, draft: LogDraft): Response {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  for (const [k, v] of Object.entries(khatewayHeaders(meta))) headers.set(k, v);
  let body = res.body;
  if (body) {
    // Tee so a background watcher can read usage off the body without
    // disturbing what the client receives.
    const [toClient, toWatch] = body.tee();
    draft.usageWatch = {
      upstream: meta.upstream,
      stream: toWatch,
      sse: (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    };
    // M16: silent upstream streams get keep-alive comments on the client
    // branch (the watcher branch stays raw — its parser skips comments).
    body = draft.usageWatch.sse ? withSseKeepAlive(toClient) : toClient;
  }
  return new Response(body, { status: res.status, headers });
}

async function respondTranslated(res: Response, meta: ChatMeta, draft: LogDraft): Promise<Response> {
  // M12 native Gemini: the upstream speaks its own dialect, so every gemini
  // pairing is translated. Normalize the payload/stream onto OPENAI chat
  // shapes first (dialects/gemini.ts), then serve through the exact openai-
  // upstream paths below — the openai client face becomes passthrough of the
  // normalized body, anthropic/responses clients reuse their translators.
  if (meta.upstream === 'gemini') {
    const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    if (isSse && res.body) {
      // Usage rides the synthesized chunks (Gemini always sends usageMetadata
      // on the final chunk), so the downstream openai tee-watcher sees it.
      const normalized = transformGeminiSseToOpenAi(res.body, meta.requested, {
        includeUsage: meta.streamIncludeUsage === true,
      });
      res = new Response(withSseKeepAlive(normalized), { status: res.status, headers: { 'content-type': 'text/event-stream' } });
    } else {
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!payload) {
        draft.error = `Upstream provider '${meta.candidate.provider.name}' returned a non-JSON body.`;
        return errorJson(
          meta.dialect,
          502,
          dialectError(meta.dialect, 502, draft.error, { code: 'upstream_invalid_response' }),
          khatewayHeaders(meta),
        );
      }
      // Log usage from the RAW payload (thoughtsTokenCount folds into output);
      // downstream paths re-derive the identical numbers from the normalized body.
      draft.usage = usageFromJsonBody('gemini', payload);
      res = new Response(JSON.stringify(geminiCompletionToOpenAi(payload, meta.requested)), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    meta = { ...meta, upstream: 'openai' };
  }
  if (meta.upstream === meta.dialect) return passthrough(res, meta, draft);
  const headers = khatewayHeaders(meta);
  const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');

  // Responses client: both upstream dialects are translated back into
  // Responses objects/events (no responses upstream adapter exists).
  if (meta.dialect === 'responses') {
    if (isSse && res.body) {
      const [toClient, toWatch] = res.body.tee();
      draft.usageWatch = { upstream: meta.upstream, stream: toWatch, sse: true };
      const stream =
        meta.upstream === 'anthropic'
          ? transformAnthropicSseToResponses(toClient, meta.requested, { structuredOutput: meta.structuredOutput === true })
          : transformOpenAiSseToResponses(toClient, meta.requested);
      return new Response(withSseKeepAlive(stream), { status: 200, headers: { ...headers, 'content-type': 'text/event-stream' } });
    }
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      draft.error = `Upstream provider '${meta.candidate.provider.name}' returned a non-JSON body.`;
      return errorJson('responses', 502, openAiError(502, draft.error, { code: 'upstream_invalid_response' }), headers);
    }
    draft.usage = usageFromJsonBody(meta.upstream, payload);
    const body =
      meta.upstream === 'anthropic'
        ? anthropicMessageToResponse(payload, meta.requested, { structuredOutput: meta.structuredOutput === true })
        : openAiCompletionToResponse(payload, meta.requested);
    return Response.json(body, { status: 200, headers });
  }

  if (meta.upstream === 'anthropic') {
    // anthropic upstream → openai client
    if (isSse && res.body) {
      const [toClient, toWatch] = res.body.tee();
      draft.usageWatch = { upstream: meta.upstream, stream: toWatch, sse: true };
      return new Response(
        withSseKeepAlive(
          transformAnthropicSseToOpenAi(toClient, meta.requested, {
            includeUsage: meta.streamIncludeUsage === true,
            structuredOutput: meta.structuredOutput === true,
          }),
        ),
        {
          status: 200,
          headers: { ...headers, 'content-type': 'text/event-stream' },
        },
      );
    }
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
      draft.error = `Upstream provider '${meta.candidate.provider.name}' returned a non-JSON body.`;
      return errorJson('openai', 502, openAiError(502, draft.error, { code: 'upstream_invalid_response' }), headers);
    }
    draft.usage = usageFromJsonBody(meta.upstream, payload);
    return Response.json(
      anthropicMessageToOpenAiCompletion(payload, meta.requested, { structuredOutput: meta.structuredOutput === true }),
      { status: 200, headers },
    );
  }

  // openai-compatible upstream → anthropic client
  if (isSse && res.body) {
    const [toClient, toWatch] = res.body.tee();
    draft.usageWatch = { upstream: meta.upstream, stream: toWatch, sse: true };
    return new Response(withSseKeepAlive(transformOpenAiSseToAnthropic(toClient, meta.requested)), {
      status: 200,
      headers: { ...headers, 'content-type': 'text/event-stream' },
    });
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    draft.error = `Upstream provider '${meta.candidate.provider.name}' returned a non-JSON body.`;
    return errorJson('anthropic', 502, anthropicError(502, `Upstream provider '${meta.candidate.provider.name}' returned a non-JSON body.`), headers);
  }
  draft.usage = usageFromJsonBody(meta.upstream, payload);
  return Response.json(openAiCompletionToAnthropicMessage(payload, meta.requested), { status: 200, headers });
}

/**
 * Serves a semantic-cache hit (M11): replays the stored raw upstream payload
 * through the exact same respondTranslated path a miss would have taken
 * (same-dialect passthrough / cross-dialect translation), so a cached response
 * is indistinguishable from a fresh one apart from the x-khateway-cache header
 * and the near-zero latency. Usage/cost come from the stored payload; the log
 * attributes the entry's original provider + upstream model. Returns null when
 * the stored payload is unusable (corrupt row) so the caller falls through to
 * the normal upstream path.
 */
async function serveCachedResponse(
  entry: { providerId: string | null; providerName: string; upstreamModel: string; upstream: string; payload: string },
  dialect: ClientDialect,
  parsed: { model: string; request: CanonicalChatRequest },
  resolved: { candidate: RoutingCandidate },
  t0: number,
  draft: LogDraft,
  rateHeaders: Record<string, string> | null = null,
): Promise<Response | null> {
  let payload: unknown;
  try {
    payload = JSON.parse(entry.payload);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const upstream: UpstreamAdapter = entry.upstream === 'anthropic' ? 'anthropic' : entry.upstream === 'gemini' ? 'gemini' : 'openai';
  // Header truth: who actually produced the cached payload (may differ from
  // the primary candidate when the entry was stored by a fallback chain walk).
  const meta: ChatMeta = {
    requested: parsed.model,
    candidate: {
      ...resolved.candidate,
      provider: { ...resolved.candidate.provider, name: entry.providerName },
      model: { ...resolved.candidate.model, upstreamModel: entry.upstreamModel },
    },
    latencyMs: Date.now() - t0,
    dialect,
    upstream,
    attempts: 1,
    cacheState: 'hit',
    // M18: a cached anthropic payload produced under structured-output
    // emulation stores the raw tool_use block — replay must unwrap it exactly
    // like a fresh response did (same helper the live path keyed the flag on).
    structuredOutput: upstream === 'anthropic' && anthropicStructuredOutputTool(parsed.request) !== null,
    rateHeaders,
  };
  draft.providerId = entry.providerId;
  draft.upstreamModel = entry.upstreamModel;
  // Billing/pricing follows the REQUESTED model (the cache key's slug) — the
  // entry may have been produced by a fallback candidate whose pricing differs.
  draft.pricingInput = resolved.candidate.model.pricingInput;
  draft.pricingOutput = resolved.candidate.model.pricingOutput;
  draft.usage = usageFromJsonBody(upstream, payload as Record<string, unknown>);
  const response = await respondTranslated(
    new Response(entry.payload, { status: 200, headers: { 'content-type': 'application/json' } }),
    meta,
    draft,
  );
  // Usage is already final from the cached payload — passthrough's tee-watcher
  // would only duplicate the log update.
  draft.usageWatch = null;
  return response;
}

/**
 * The chat pipeline shared by all client dialects: dialect parse → routing
 * (primary + fallback chain) → per-candidate upstream build/invoke, falling
 * through the chain on 429/5xx/timeout/network/unusable-provider outcomes →
 * outcome mapping (errors rendered in the caller's dialect) → same-dialect
 * passthrough or cross-dialect translation. 4xx upstream errors (except 429)
 * are the client's fault and surface immediately. M7: enforces the client
 * key's spend cap + allowed-model list and records a request_logs row for
 * every pipeline outcome. M11: eligible text-only requests check the semantic
 * cache after every gate (spend cap, rate limits, allow-list, balance) — hits
 * serve without touching upstream; misses store their raw upstream JSON.
 */
/** waitUntil that survives harnesses without an execution context. */
function makeWaitUntil(c: Context<GatewayEnv>): (p: Promise<unknown>) => void {
  return (p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // no execution context (non-workers harness) — let the promise run free
      void p;
    }
  };
}

async function runChatPipeline(
  c: Context<GatewayEnv>,
  dialect: ClientDialect,
  opts: {
    /** request_logs.dialect override (M16: 'completions' for the legacy face). */
    dialectLabel?: LogDraft['dialect'];
    /** M16 /v1/completions: the request was parsed by the legacy-completions
     * parser into a canonical chat request — skip the dialect parse. */
    preParsed?: { model: string; request: CanonicalChatRequest };
  } = {},
): Promise<Response> {
  const t0 = Date.now();
  const draft: LogDraft = {
    apiKeyId: c.get('clientKey')?.id ?? null,
    userId: c.get('clientKey')?.userId ?? null,
    orgId: c.get('clientKey')?.orgId ?? null,
    dialect: opts.dialectLabel ?? LOG_DIALECT[dialect],
    modelSlug: '',
    providerId: null,
    upstreamModel: null,
    usage: null,
    pricingInput: null,
    pricingOutput: null,
    usageWatch: null,
    cacheHit: false,
    error: null,
    ...attributionFrom(c),
  };
  const res = await chatPipeline(c, dialect, draft, t0, opts.preParsed);
  await writeRequestLog(c.env, draft, res, Date.now() - t0, makeWaitUntil(c));
  return res;
}

/**
 * M7 spend cap: once a key's accrued cost reaches its limit it stops serving
 * (soft cap — concurrent in-flight requests can overshoot). Shared by the
 * chat and embeddings pipelines; returns the 429 Response when refused.
 */
async function enforceSpendCap(
  c: Context<GatewayEnv>,
  key: ApiKeyRow | null,
  dialect: ClientDialect,
  draft: LogDraft,
): Promise<Response | null> {
  if (key?.spendLimitUsd == null) return null;
  const [spent] = await getDb(c.env).select({ total: sum(requestLogs.costUsd) }).from(requestLogs).where(eq(requestLogs.apiKeyId, key.id));
  const total = spent?.total != null ? Number(spent.total) : 0;
  if (total >= key.spendLimitUsd) {
    draft.error = `Spend cap reached: accrued $${total.toFixed(4)} of the $${key.spendLimitUsd} limit for key '${key.name}'.`;
    return errorJson(
      dialect,
      429,
      dialectError(dialect, 429, draft.error, { code: 'spend_limit_exceeded', type: 'insufficient_quota' }),
    );
  }
  return null;
}

/**
 * P4: rough pre-request cost estimate for a capped key — input tokens from
 * the usual chars/4 heuristic over all message text + tool arguments, output
 * tokens from the effective max-output cap (client value, model default, or
 * 4096 — itself capped so one big `max_tokens` cannot freeze a whole limit).
 * null when the model has no pricing to estimate with (those requests never
 * debit either) or the estimate rounds to zero.
 */
function estimateChatCostUsd(request: CanonicalChatRequest, cand: RoutingCandidate): number | null {
  const { pricingInput, pricingOutput } = cand.model;
  if (pricingInput == null && pricingOutput == null) return null;
  let chars = 0;
  for (const m of request.messages) {
    chars += m.content.length;
    for (const tc of m.toolCalls ?? []) chars += tc.arguments.length;
  }
  const tokensIn = Math.ceil(chars / 4);
  const maxOut = request.options.maxTokens ?? cand.model.maxOutputTokens ?? 4096;
  const tokensOut = Math.max(0, Math.min(Math.round(maxOut), 4096));
  // pricing is USD per 1M tokens (same contract as costUsd).
  const est =
    (pricingInput != null ? (tokensIn / 1e6) * pricingInput : 0) +
    (pricingOutput != null ? (tokensOut / 1e6) * pricingOutput : 0);
  return est > 0 ? est : null;
}

/** P4: embeddings estimate — input-only (M13 cost model: tokensIn × pricing_input). */
function estimateEmbeddingsCostUsd(request: CanonicalEmbeddingsRequest, cand: RoutingCandidate): number | null {
  if (cand.model.pricingInput == null) return null;
  const chars = request.input.reduce((a, t) => a + t.length, 0);
  const est = (Math.ceil(chars / 4) / 1e6) * (cand.model.pricingInput as number); // USD per 1M
  return est > 0 ? est : null;
}

/**
 * P4: parks this request's estimated spend in the DO so concurrent capped-key
 * requests see each other instead of all reading the same stale SUM. Refuses
 * (429, same envelope as the M7 cap) when accrued + in-flight would reach the
 * limit, releasing the just-added reservation; fail-open when the limiter is
 * unreachable (soft cap as before). Runs after routing because the estimate
 * needs the resolved model's pricing.
 */
async function reserveSpendCap(
  c: Context<GatewayEnv>,
  key: ApiKeyRow | null,
  dialect: ClientDialect,
  draft: LogDraft,
  estUsd: number | null,
): Promise<Response | null> {
  if (key?.spendLimitUsd == null || estUsd == null) return null;
  const micros = Math.round(estUsd * 1e6);
  if (micros <= 0) return null;
  const scope = `reserve:key:${key.id}`;
  const reserved = await reserveSpend(c.env, scope, micros);
  if (reserved == null) return null; // limiter down → soft cap as before
  const [spent] = await getDb(c.env).select({ total: sum(requestLogs.costUsd) }).from(requestLogs).where(eq(requestLogs.apiKeyId, key.id));
  const total = spent?.total != null ? Number(spent.total) : 0;
  if (total + reserved / 1e6 >= key.spendLimitUsd) {
    await settleSpend(c.env, scope, micros); // release ours before refusing
    draft.error = `Spend cap reached: accrued $${total.toFixed(4)} plus $${(reserved / 1e6).toFixed(4)} in flight of the $${key.spendLimitUsd} limit for key '${key.name}'.`;
    return errorJson(
      dialect,
      429,
      dialectError(dialect, 429, draft.error, { code: 'spend_limit_exceeded', type: 'insufficient_quota' }),
    );
  }
  draft.spendReservation = { scope, micros };
  return null;
}

/**
 * M16: OpenAI-style success-path rate-limit headers from the BINDING bucket
 * (max count/limit — the same pick the 429 path names). Headers appear only
 * when limiting actually ran (settings on, limiter healthy).
 */
function rateLimitHeaders(decisions: RateLimitDecision[]): Record<string, string> | null {
  if (decisions.length === 0) return null;
  const binding = decisions.reduce((a, b) => (b.count / b.limit > a.count / a.limit ? b : a));
  return {
    'x-ratelimit-limit-requests': String(binding.limit),
    'x-ratelimit-remaining-requests': String(Math.max(0, binding.limit - binding.count)),
    'x-ratelimit-reset-requests': `${Math.max(1, Math.ceil(binding.resetAfterMs / 1000))}s`,
  };
}

/**
 * Gates that need the resolved model, shared by the chat and embeddings
 * pipelines (M13 extraction — behavior identical to the inline originals):
 * M10 rate limits (per-key / per-IP anonymous / per-model), the M7 per-key
 * allow-list, and the M8/M9 prepaid balance gate. Returns the error Response
 * when a gate refuses (response: null otherwise); rateHeaders carries the M16
 * success-path x-ratelimit-* values for the eventual response.
 */
async function enforcePostRoutingGates(
  c: Context<GatewayEnv>,
  key: ApiKeyRow,
  dialect: ClientDialect,
  draft: LogDraft,
  resolved: { candidate: RoutingCandidate },
): Promise<{ response: Response | null; rateHeaders: Record<string, string> | null }> {
  // M10 rate limits: per-key (deployment default or the key's override) /
  // per-IP for anonymous (keyless-native traffic is the abuse surface), plus
  // the model's optional global per-minute cap. One DO round-trip; a denied
  // bucket answers 429 + Retry-After in the caller's dialect. Fail-open on
  // limiter errors (checkRateLimits → null). Logged like any other outcome.
  const rl = await getRateLimitSettings(c.env);
  const decisions = await checkRateLimits(
    c.env,
    buildGatewayRateChecks({
      settings: rl,
      key: key ? { id: key.id, rateLimitRpm: key.rateLimitRpm } : null,
      ip: c.req.header('cf-connecting-ip') ?? 'unknown',
      modelSlug: resolved.candidate.model.slug,
      modelRpm: resolved.candidate.model.rateLimitRpm,
    }),
  );
  const rateHeaders = decisions ? rateLimitHeaders(decisions) : null;
  if (decisions) {
    const deniedList = decisions.filter((d) => !d.allowed);
    if (deniedList.length > 0) {
      // Name the binding constraint (the most-exhausted denied bucket) and
      // report the longest wait — with equal windows they coincide.
      const binding = deniedList.reduce((a, b) => (b.count / b.limit > a.count / a.limit ? b : a));
      const retryAfterSec = Math.max(1, Math.ceil(Math.max(...deniedList.map((d) => d.resetAfterMs)) / 1000));
      const what =
        binding.kind === 'model'
          ? `Model '${resolved.candidate.model.slug}'`
          : binding.kind === 'key'
            ? `API key '${key?.name}'`
            : 'Your IP address';
      draft.error = `Rate limit exceeded: ${binding.limit} requests/minute for this ${binding.kind} bucket (${binding.scope}).`;
      return {
        response: errorJson(
          dialect,
          429,
          dialectError(dialect, 429, `${what} has exceeded its rate limit of ${binding.limit} requests per minute — retry in ${retryAfterSec}s.`, {
            code: 'rate_limit_exceeded',
          }),
          { 'retry-after': String(retryAfterSec) },
        ),
        rateHeaders,
      };
    }
  }

  // M7 per-key allow-list: an empty/absent list means every model.
  const allowed = parseAllowedModels(key?.allowedModels);
  if (key && allowed.length > 0 && !allowed.includes(resolved.candidate.model.slug)) {
    draft.error = `API key '${key.name}' is not allowed to use model '${resolved.candidate.model.slug}'.`;
    return {
      response: errorJson(dialect, 403, dialectError(dialect, 403, draft.error, { code: 'model_not_allowed', type: 'permission_error' })),
      rateHeaders,
    };
  }

  // M8 prepaid balance: user-owned keys draw down their account's credit.
  // M9: org keys draw down the ORG's shared balance instead. Both refuse at
  // balance ≤ 0 with the same quota envelope as the M7 spend cap.
  if (key.orgId) {
    const [org] = await getDb(c.env)
      .select({ balance: orgs.balanceUsdMicros, enabled: orgs.enabled })
      .from(orgs)
      .where(eq(orgs.id, key.orgId));
    if (!org || !org.enabled || org.balance <= 0) {
      draft.error = `Prepaid balance exhausted for the organization owning key '${key.name}' — ask an org owner to top up in the Khateway portal to continue.`;
      return {
        response: errorJson(
          dialect,
          429,
          dialectError(dialect, 429, draft.error, { code: 'insufficient_quota', type: 'insufficient_quota' }),
        ),
        rateHeaders,
      };
    }
  } else if (key.userId) {
    const [acct] = await getDb(c.env)
      .select({ balance: users.balanceUsdMicros, enabled: users.enabled })
      .from(users)
      .where(eq(users.id, key.userId));
    if (!acct || !acct.enabled || acct.balance <= 0) {
      draft.error = `Prepaid balance exhausted for the account owning key '${key.name}' — top up in the Khateway portal to continue.`;
      return {
        response: errorJson(
          dialect,
          429,
          dialectError(dialect, 429, draft.error, { code: 'insufficient_quota', type: 'insufficient_quota' }),
        ),
        rateHeaders,
      };
    }
  }
  return { response: null, rateHeaders };
}

async function chatPipeline(
  c: Context<GatewayEnv>,
  dialect: ClientDialect,
  draft: LogDraft,
  t0: number,
  preParsed?: { model: string; request: CanonicalChatRequest },
): Promise<Response> {
  try {
    const parsed = preParsed
      ? { ok: true as const, model: preParsed.model, request: preParsed.request }
      : dialect === 'anthropic'
        ? await parseAnthropicMessagesRequest(c.req)
        : dialect === 'responses'
          ? await parseOpenAiResponsesRequest(c.req)
          : await parseOpenAiChatRequest(c.req);
    if (!parsed.ok) {
      draft.error = parsed.message;
      return errorJson(dialect, parsed.status, dialectError(dialect, parsed.status, parsed.message, { param: parsed.param, code: parsed.code }));
    }
    draft.modelSlug = parsed.model;

    const key = c.get('clientKey');
    const capped = await enforceSpendCap(c, key, dialect, draft);
    if (capped) return capped;

    const resolved = await resolveModelChain(c.env, parsed.model);
    if (!resolved.ok) {
      draft.error = resolved.message;
      return errorJson(dialect, resolved.status, dialectError(dialect, resolved.status, resolved.message, { code: resolved.code }));
    }

    const gated = await enforcePostRoutingGates(c, key!, dialect, draft, resolved) // middleware 401s without a key;
    if (gated.response) return gated.response;
    const rateHeaders = gated.rateHeaders;

    // P4: park the estimated spend so concurrent capped-key requests cannot
    // all slip past the same stale SUM (soft-cap overshoot).
    const reserved = await reserveSpendCap(c, key!, dialect, draft, estimateChatCostUsd(parsed.request, resolved.candidate));
    if (reserved) return reserved;

    // M11 semantic cache: opt-in per model (models.cache_enabled) OR per key
    // (api_keys.cache_enabled) while the deployment master switch is on, and
    // only for text-only non-streaming requests (evaluateCacheEligibility).
    // The lookup is one D1 read, fail-open (a cache error is a miss); a hit
    // never bypassed any gate above, so billing/logging behave exactly like a
    // served request — the debit path runs with the cached usage.
    const cacheSettings = await getCacheSettings(c.env);
    let cacheKey: string | null = null;
    let cacheTtlSeconds = 0;
    if (cacheSettings.enabled && cacheSettings.ttlSeconds >= 1) {
      const optedIn = resolved.candidate.model.cacheEnabled || key?.cacheEnabled === true;
      if (evaluateCacheEligibility(parsed.request, { optedIn }).eligible) {
        cacheTtlSeconds = cacheSettings.ttlSeconds;
        cacheKey = await buildCacheKey(parsed.request, resolved.candidate.model.slug);
        const entry = await lookupCacheEntry(c.env, cacheKey);
        if (entry) {
          const hit = await serveCachedResponse(entry, dialect, parsed, resolved, t0, draft, rateHeaders);
          if (hit) {
            draft.cacheHit = true;
            return hit;
          }
          // Unusable stored payload — fall through and serve fresh.
        }
      }
    }

    const chain = [resolved.candidate, ...resolved.fallbacks];

    // Last failure of each kind wins when the chain is exhausted.
    let lastTimeout: { provider: string; timeoutMs: number } | null = null;
    let lastNetwork: { provider: string; message: string } | null = null;
    let lastUpstreamError: { status: number; raw: string; retryAfter: string | null; meta: ChatMeta } | null = null;
    let lastBuildError: unknown = null;
    // P3: wall-clock already spent waiting between retries (shared budget).
    let totalWaitedMs = 0;

    let attempts = 0;
    chatAdapterLoop: for (const cand of chain) {
      // Providers declare the upstream dialects they speak (≥1 — admin CRUD
      // validates). A dual-adapter provider tries its preferred adapter first
      // and can serve the same request through the other one on translation
      // failure, all without consuming a fallback-chain slot.
      const usable = cand.provider.adapters.filter(
        (a): a is UpstreamAdapter => a === 'openai' || a === 'anthropic' || a === 'gemini',
      );
      if (usable.length === 0) {
        return errorJson(
          dialect,
          501,
          dialectError(dialect, 501, `Provider '${cand.provider.name}' has no usable adapter configured.`, { code: 'upstream_dialect_unsupported' }),
        );
      }
      const adapterOrder: UpstreamAdapter[] = [preferredAdapter(dialect, usable), ...usable.filter((a) => a !== preferredAdapter(dialect, usable))];

      // P3: a transient upstream failure (429/5xx) retries THIS upstream once
      // after a budgeted wait before the chain falls through.
      adapterRetry: for (const upstream of adapterOrder) {
        let triesOnUpstream = 0;
        while (true) {
          triesOnUpstream++;
          attempts++;
        const meta: ChatMeta = {
          requested: parsed.model,
          candidate: cand,
          latencyMs: Date.now() - t0,
          dialect,
          upstream,
          attempts,
          streamIncludeUsage: parsed.request.streamIncludeUsage,
          // M18: structured-output emulation is an anthropic-upstream property
          // (the synthetic forced tool + the translators' unwrap flag).
          structuredOutput: upstream === 'anthropic' && anthropicStructuredOutputTool(parsed.request) !== null,
          rateHeaders,
        };
        // The last candidate tried owns the log row (matches the last-failure-wins mapping).
        draft.providerId = cand.provider.id;
        draft.upstreamModel = cand.model.upstreamModel;
        draft.pricingInput = cand.model.pricingInput;
        draft.pricingOutput = cand.model.pricingOutput;

        let built: UpstreamRequest;
        let outcome: UpstreamOutcome;
        try {
          built =
            upstream === 'anthropic'
              ? await buildAnthropicMessagesRequest(c.env, cand, parsed.request)
              : upstream === 'gemini'
                ? await buildGeminiGenerateContentRequest(c.env, cand, parsed.request)
                : await buildOpenAiChatRequest(c.env, cand, parsed.request);
          outcome = await invokeUpstream(built);
        } catch (err) {
          if (err instanceof UnsupportedTranslationError) {
            // This adapter cannot express the request (e.g. n>1 on Messages).
            // Dual-adapter providers get retried through their other dialect.
            lastBuildError = err;
            continue adapterRetry;
          }
          if (err instanceof UpstreamMisconfigError) {
            // Credentials/config are adapter-independent — skip the provider.
            lastBuildError = err;
            continue chatAdapterLoop;
          }
          throw err;
        }

        if (outcome.kind === 'timeout') {
          lastTimeout = { provider: cand.provider.name, timeoutMs: built.timeoutMs };
          continue chatAdapterLoop;
        }
        if (outcome.kind === 'network') {
          lastNetwork = { provider: cand.provider.name, message: outcome.message };
          continue chatAdapterLoop;
        }

        if (outcome.res.status >= 500 || outcome.res.status === 429) {
          // Retryable upstream failure — remember it (small body); retry THIS
          // upstream once after a budgeted wait (P3), else fall through.
          const raw = await outcome.res.text().catch(() => '');
          const retryAfter = outcome.res.headers.get('retry-after');
          lastUpstreamError = { status: outcome.res.status, raw, retryAfter, meta };
          if (triesOnUpstream < 2) {
            const decision = retryDecision({ status: outcome.res.status, retryAfterHeader: retryAfter, attempt: triesOnUpstream - 1, totalWaitedMs });
            if (decision.retrySame) {
              if (decision.waitMs > 0) await sleep(decision.waitMs);
              totalWaitedMs += decision.waitMs;
              continue;
            }
          }
          continue chatAdapterLoop;
        }

        if (outcome.res.status >= 400) {
          // Client error: retrying elsewhere cannot help — surface immediately.
          const raw = await outcome.res.text().catch(() => '');
          draft.error = `upstream ${outcome.res.status}: ${raw || outcome.res.statusText}`;
          return errorJson(dialect, outcome.res.status, upstreamErrorBody(dialect, upstream, outcome.res.status, raw), khatewayHeaders(meta));
        }

        meta.latencyMs = Date.now() - t0;
        if (cacheKey && (outcome.res.headers.get('content-type') ?? '').includes('application/json')) {
          meta.cacheState = 'miss';
          try {
            const snapshot = outcome.res.clone();
            c.executionCtx.waitUntil(
              storeCacheEntry(c.env, {
                key: cacheKey,
                modelSlug: resolved.candidate.model.slug,
                upstream,
                providerId: cand.provider.id,
                providerName: cand.provider.name,
                upstreamModel: cand.model.upstreamModel,
                body: snapshot.body,
                ttlSeconds: cacheTtlSeconds,
              }),
            );
          } catch {
            // no execution context (non-workers harness) — caching is skipped
          }
        }
        return await respondTranslated(outcome.res, meta, draft);
        }
      }
    }

    // Chain exhausted — surface the most informative failure.
    if (lastUpstreamError) {
      draft.error = `upstream ${lastUpstreamError.status}: ${lastUpstreamError.raw}`;
      return errorJson(
        dialect,
        lastUpstreamError.status,
        upstreamErrorBody(dialect, lastUpstreamError.meta.upstream, lastUpstreamError.status, lastUpstreamError.raw),
        // P3: a chain-exhausted 429 relays the upstream's own Retry-After.
        {
          ...khatewayHeaders(lastUpstreamError.meta),
          ...(lastUpstreamError.status === 429 && lastUpstreamError.retryAfter ? { 'retry-after': lastUpstreamError.retryAfter } : {}),
        },
      );
    }
    if (lastTimeout) {
      draft.error = `upstream timeout after ${lastTimeout.timeoutMs} ms (${lastTimeout.provider})`;
      return errorJson(
        dialect,
        504,
        dialectError(dialect, 504, `Upstream provider '${lastTimeout.provider}' timed out after ${lastTimeout.timeoutMs} ms.`, { code: 'upstream_timeout' }),
      );
    }
    if (lastNetwork) {
      draft.error = `upstream unreachable: ${lastNetwork.message}`;
      return errorJson(
        dialect,
        502,
        dialectError(dialect, 502, `Upstream provider '${lastNetwork.provider}' is unreachable: ${lastNetwork.message}`, { code: 'upstream_unreachable' }),
      );
    }
    if (lastBuildError instanceof UpstreamMisconfigError) {
      draft.error = lastBuildError.message;
      return errorJson(dialect, 500, dialectError(dialect, 500, lastBuildError.message, { code: 'provider_misconfigured' }));
    }
    if (lastBuildError instanceof UnsupportedTranslationError) {
      draft.error = lastBuildError.message;
      return errorJson(dialect, 400, dialectError(dialect, 400, lastBuildError.message, { code: 'untranslatable_request' }));
    }
    return errorJson(dialect, 500, dialectError(dialect, 500, 'Internal gateway error'));
  } catch (err) {
    if (err instanceof UpstreamMisconfigError) {
      draft.error = err.message;
      return errorJson(dialect, 500, dialectError(dialect, 500, err.message, { code: 'provider_misconfigured' }));
    }
    if (err instanceof UnsupportedTranslationError) {
      draft.error = err.message;
      return errorJson(dialect, 400, dialectError(dialect, 400, err.message, { code: 'untranslatable_request' }));
    }
    console.error('[gateway] unhandled error:', err);
    draft.error = err instanceof Error ? err.message : 'internal error';
    return errorJson(dialect, 500, dialectError(dialect, 500, 'Internal gateway error'));
  }
}

gatewayApp.post('/chat/completions', (c) => runChatPipeline(c, 'openai'));
gatewayApp.post('/messages', (c) => runChatPipeline(c, 'anthropic'));
gatewayApp.post('/responses', (c) => runChatPipeline(c, 'responses'));

// --------------------------------------------------------- legacy completions

/**
 * M16: the legacy OpenAI text-completions face (`POST /v1/completions`) —
 * the OpenRouter-parity endpoint older tools still call. The prompt is parsed
 * onto a canonical chat request (prompt → user message) and the request rides
 * the FULL chat pipeline (preParsed skips only the dialect parse), so keys,
 * gates, fallbacks, cache and logging behave identically. The chat-shaped
 * response is then REWRITTEN into `text_completion` shape — JSON and SSE —
 * which is why this face never takes the raw passthrough path even for
 * openai upstreams. Errors keep the OpenAI envelope (same as the chat face).
 */
async function runCompletionsPipeline(c: Context<GatewayEnv>): Promise<Response> {
  const t0 = Date.now();
  const draft: LogDraft = {
    apiKeyId: c.get('clientKey')?.id ?? null,
    userId: c.get('clientKey')?.userId ?? null,
    orgId: c.get('clientKey')?.orgId ?? null,
    dialect: 'completions',
    modelSlug: '',
    providerId: null,
    upstreamModel: null,
    usage: null,
    pricingInput: null,
    pricingOutput: null,
    usageWatch: null,
    cacheHit: false,
    error: null,
    ...attributionFrom(c),
  };
  const res = await completionsPipeline(c, draft, t0);
  await writeRequestLog(c.env, draft, res, Date.now() - t0, makeWaitUntil(c));
  return res;
}

async function completionsPipeline(c: Context<GatewayEnv>, draft: LogDraft, t0: number): Promise<Response> {
  const parsed = await parseOpenAiCompletionsRequest(c.req);
  if (!parsed.ok) {
    draft.error = parsed.message;
    return errorJson('openai', parsed.status, openAiError(parsed.status, parsed.message, { param: parsed.param, code: parsed.code }));
  }
  draft.modelSlug = parsed.model;

  const inner = await chatPipeline(c, 'openai', draft, t0, { model: parsed.model, request: parsed.request });
  if (inner.status !== 200) return inner; // already OpenAI-envelope shaped

  const isSse = (inner.headers.get('content-type') ?? '').includes('text/event-stream');
  if (isSse && inner.body) {
    // Keep-alives ride the OUTPUT here: the inner stream's comments are
    // consumed (never re-emitted) by the chunk rewriter.
    const rewritten = transformChatSseToTextCompletionSse(inner.body, parsed.model);
    return new Response(withSseKeepAlive(rewritten), {
      status: 200,
      headers: { ...inner.headers, 'content-type': 'text/event-stream' },
    });
  }
  const payload = (await inner.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    draft.error = 'Upstream provider returned a non-JSON body.';
    return errorJson('openai', 502, openAiError(502, draft.error, { code: 'upstream_invalid_response' }));
  }
  const body = completionFromChatCompletion(payload, parsed.model);
  if (!body) {
    draft.error = 'Upstream provider returned an unreadable completion payload.';
    return errorJson('openai', 502, openAiError(502, draft.error, { code: 'upstream_invalid_response' }));
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

gatewayApp.post('/completions', (c) => runCompletionsPipeline(c));

// ------------------------------------------------------------- embeddings

/**
 * M13: the first non-chat pipeline branch. POST /v1/embeddings speaks the
 * OpenAI Embeddings API — the only embeddings client face there is (Anthropic
 * has no embeddings endpoint). Routing, client-key auth, the spend-cap /
 * rate-limit / allow-list / balance gates, the fallback chain walk, request
 * logging and balance debits are shared with the chat pipeline; what differs:
 * no streaming, no cross-dialect client face, no semantic cache (the M11
 * eligibility gate is chat-shaped — widen evaluateCacheEligibility before
 * ever caching embeddings), and only two upstream adapters can express it:
 * openai-compatible `/embeddings` (response relayed untouched, usage captured
 * by the JSON watcher) and native Gemini `:embedContent`/`:batchEmbedContents`
 * (normalized onto the openai response shape; usageMetadata.promptTokenCount
 * feeds the log). Anthropic-only providers answer 501 upstream_dialect_
 * unsupported. Errors are always OpenAI-envelope shaped.
 */
async function runEmbeddingsPipeline(c: Context<GatewayEnv>): Promise<Response> {
  const t0 = Date.now();
  const draft: LogDraft = {
    apiKeyId: c.get('clientKey')?.id ?? null,
    userId: c.get('clientKey')?.userId ?? null,
    orgId: c.get('clientKey')?.orgId ?? null,
    dialect: 'embeddings',
    modelSlug: '',
    providerId: null,
    upstreamModel: null,
    usage: null,
    pricingInput: null,
    pricingOutput: null,
    usageWatch: null,
    cacheHit: false,
    error: null,
    ...attributionFrom(c),
  };
  const res = await embeddingsPipeline(c, draft, t0);
  await writeRequestLog(c.env, draft, res, Date.now() - t0, makeWaitUntil(c));
  return res;
}

async function embeddingsPipeline(c: Context<GatewayEnv>, draft: LogDraft, t0: number): Promise<Response> {
  // The embeddings client face is OpenAI-shaped; every error below uses that
  // envelope (the same one the auth middleware already answers 401s with).
  const dialect: ClientDialect = 'openai';
  try {
    const parsed = await parseOpenAiEmbeddingsRequest(c.req);
    if (!parsed.ok) {
      draft.error = parsed.message;
      return errorJson(dialect, parsed.status, dialectError(dialect, parsed.status, parsed.message, { param: parsed.param, code: parsed.code }));
    }
    draft.modelSlug = parsed.model;

    const key = c.get('clientKey');
    const capped = await enforceSpendCap(c, key, dialect, draft);
    if (capped) return capped;

    const resolved = await resolveModelChain(c.env, parsed.model);
    if (!resolved.ok) {
      draft.error = resolved.message;
      return errorJson(dialect, resolved.status, dialectError(dialect, resolved.status, resolved.message, { code: resolved.code }));
    }

    const gated = await enforcePostRoutingGates(c, key!, dialect, draft, resolved) // middleware 401s without a key;
    if (gated.response) return gated.response;
    const rateHeaders = gated.rateHeaders;

    // P4: park the estimated spend (input-only cost model for embeddings).
    const embReserved = await reserveSpendCap(c, key!, dialect, draft, estimateEmbeddingsCostUsd(parsed.request, resolved.candidate));
    if (embReserved) return embReserved;

    const chain = [resolved.candidate, ...resolved.fallbacks];

    // Last failure of each kind wins when the chain is exhausted (same
    // mapping as the chat pipeline).
    let lastTimeout: { provider: string; timeoutMs: number } | null = null;
    let lastNetwork: { provider: string; message: string } | null = null;
    let lastUpstreamError: { status: number; raw: string; retryAfter: string | null; meta: ChatMeta } | null = null;
    let lastBuildError: UpstreamMisconfigError | null = null;

    let attempts = 0;
    let totalWaitedMs = 0; // P3: shared between-retry wait budget
    embedAdapterLoop: for (const cand of chain) {
      // Embeddings-capable upstream adapters: openai-compatible (POST
      // /embeddings) and native Gemini (:embedContent / :batchEmbedContents).
      const usable = cand.provider.adapters.filter((a): a is 'openai' | 'gemini' => a === 'openai' || a === 'gemini');
      if (usable.length === 0) {
        return errorJson(
          dialect,
          501,
          dialectError(
            dialect,
            501,
            `Provider '${cand.provider.name}' cannot serve embeddings — no openai-compatible or native-gemini adapter is configured (the anthropic dialect has no embeddings endpoint).`,
            { code: 'upstream_dialect_unsupported' },
          ),
        );
      }
      // Openai first: it matches the client face (passthrough, no response
      // translation) and is what openai-compatible proxies serve.
      const adapterOrder: ('openai' | 'gemini')[] = usable.includes('openai')
        ? ['openai', ...usable.filter((a) => a !== 'openai')]
        : usable;

      embedRetry: for (const upstream of adapterOrder) {
        // P3: one budgeted same-upstream retry for transient failures.
        let triesOnUpstream = 0;
        while (true) {
          triesOnUpstream++;
          attempts++;
          const meta: ChatMeta = {
            requested: parsed.model,
            candidate: cand,
            latencyMs: Date.now() - t0,
            dialect,
            upstream,
            attempts,
            rateHeaders,
          };
        // The last candidate tried owns the log row (matches the last-failure-wins mapping).
        draft.providerId = cand.provider.id;
        draft.upstreamModel = cand.model.upstreamModel;
        draft.pricingInput = cand.model.pricingInput;
        draft.pricingOutput = cand.model.pricingOutput;

        let built: UpstreamRequest;
        let outcome: UpstreamOutcome;
        try {
          built =
            upstream === 'gemini'
              ? await buildGeminiEmbeddingsRequest(c.env, cand, parsed.request)
              : await buildOpenAiEmbeddingsRequest(c.env, cand, parsed.request);
          outcome = await invokeUpstream(built);
        } catch (err) {
          if (err instanceof UpstreamMisconfigError) {
            // Credentials/config are adapter-independent — skip the provider.
            lastBuildError = err;
            continue embedAdapterLoop;
          }
          throw err;
        }

        if (outcome.kind === 'timeout') {
          lastTimeout = { provider: cand.provider.name, timeoutMs: built.timeoutMs };
          continue embedAdapterLoop;
        }
        if (outcome.kind === 'network') {
          lastNetwork = { provider: cand.provider.name, message: outcome.message };
          continue embedAdapterLoop;
        }

        if (outcome.res.status >= 500 || outcome.res.status === 429) {
          // Retryable upstream failure — remember it (small body); retry THIS
          // upstream once after a budgeted wait (P3), else fall through.
          const raw = await outcome.res.text().catch(() => '');
          const retryAfter = outcome.res.headers.get('retry-after');
          lastUpstreamError = { status: outcome.res.status, raw, retryAfter, meta };
          if (triesOnUpstream < 2) {
            const decision = retryDecision({ status: outcome.res.status, retryAfterHeader: retryAfter, attempt: triesOnUpstream - 1, totalWaitedMs });
            if (decision.retrySame) {
              if (decision.waitMs > 0) await sleep(decision.waitMs);
              totalWaitedMs += decision.waitMs;
              continue;
            }
          }
          continue embedAdapterLoop;
        }

        if (outcome.res.status >= 400) {
          // Client error: retrying elsewhere cannot help — surface immediately.
          const raw = await outcome.res.text().catch(() => '');
          draft.error = `upstream ${outcome.res.status}: ${raw || outcome.res.statusText}`;
          return errorJson(dialect, outcome.res.status, upstreamErrorBody(dialect, upstream, outcome.res.status, raw), khatewayHeaders(meta));
        }

        meta.latencyMs = Date.now() - t0;
        if (upstream === 'gemini') {
          // Native Gemini: buffer the (small, float-array) payload, normalize
          // onto the openai embeddings shape, and log usage straight from the
          // raw body (usageMetadata.promptTokenCount → tokensIn).
          const payload = (await outcome.res.json().catch(() => null)) as Record<string, unknown> | null;
          if (!payload) {
            draft.error = `Upstream provider '${cand.provider.name}' returned a non-JSON body.`;
            return errorJson(
              dialect,
              502,
              dialectError(dialect, 502, draft.error, { code: 'upstream_invalid_response' }),
              khatewayHeaders(meta),
            );
          }
          draft.usage = usageFromJsonBody('gemini', payload);
          return Response.json(geminiEmbeddingsToOpenAi(payload, meta.requested, parsed.request.encodingFormat), {
            status: 200,
            headers: khatewayHeaders(meta),
          });
        }
        // openai-compatible upstream: relay the response untouched and tee a
        // branch for the JSON usage watcher (tokens + cost land after the
        // client-facing response has been returned, exactly like chat).
        return passthrough(outcome.res, meta, draft);
        }
      }
    }

    // Chain exhausted — surface the most informative failure.
    if (lastUpstreamError) {
      draft.error = `upstream ${lastUpstreamError.status}: ${lastUpstreamError.raw}`;
      return errorJson(
        dialect,
        lastUpstreamError.status,
        upstreamErrorBody(dialect, lastUpstreamError.meta.upstream, lastUpstreamError.status, lastUpstreamError.raw),
        // P3: a chain-exhausted 429 relays the upstream's own Retry-After.
        {
          ...khatewayHeaders(lastUpstreamError.meta),
          ...(lastUpstreamError.status === 429 && lastUpstreamError.retryAfter ? { 'retry-after': lastUpstreamError.retryAfter } : {}),
        },
      );
    }
    if (lastTimeout) {
      draft.error = `upstream timeout after ${lastTimeout.timeoutMs} ms (${lastTimeout.provider})`;
      return errorJson(
        dialect,
        504,
        dialectError(dialect, 504, `Upstream provider '${lastTimeout.provider}' timed out after ${lastTimeout.timeoutMs} ms.`, { code: 'upstream_timeout' }),
      );
    }
    if (lastNetwork) {
      draft.error = `upstream unreachable: ${lastNetwork.message}`;
      return errorJson(
        dialect,
        502,
        dialectError(dialect, 502, `Upstream provider '${lastNetwork.provider}' is unreachable: ${lastNetwork.message}`, { code: 'upstream_unreachable' }),
      );
    }
    if (lastBuildError) {
      draft.error = lastBuildError.message;
      return errorJson(dialect, 500, dialectError(dialect, 500, lastBuildError.message, { code: 'provider_misconfigured' }));
    }
    return errorJson(dialect, 500, dialectError(dialect, 500, 'Internal gateway error'));
  } catch (err) {
    if (err instanceof UpstreamMisconfigError) {
      draft.error = err.message;
      return errorJson(dialect, 500, dialectError(dialect, 500, err.message, { code: 'provider_misconfigured' }));
    }
    console.error('[gateway] unhandled embeddings error:', err);
    draft.error = err instanceof Error ? err.message : 'internal error';
    return errorJson(dialect, 500, dialectError(dialect, 500, 'Internal gateway error'));
  }
}

gatewayApp.post('/embeddings', (c) => runEmbeddingsPipeline(c));

// ---------------------------------------------------------- unknown /v1/*

// Since M7 the auth middleware above runs before this route: unknown endpoints
// answer 401 without a valid client key, 404 with one. Note: a mounted sub-app's
// notFound() is bypassed by the root app — the wildcard route below owns the
// "unknown /v1 endpoint" case. The dialect is unknowable there, so the OpenAI
// envelope is used for both.
gatewayApp.all('*', (c) =>
  errorJson(
    'openai',
    404,
    openAiError(404, `Unknown gateway endpoint: '${c.req.method} ${c.req.path}'`, { code: 'unknown_endpoint' }),
  ),
);
