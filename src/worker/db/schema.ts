import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url'), // null => adapter default (first adapter)
  apiKeyEnc: text('api_key_enc'), // AES-256-GCM, "v1.<iv>.<ct>"
  keyHint: text('key_hint'), // last 4 chars, for the UI only
  defaultHeaders: text('default_headers'), // JSON string
  timeoutMs: integer('timeout_ms'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // JSON array of upstream adapters this provider speaks, e.g. '["openai"]' or
  // '["openai","anthropic"]' for dual-dialect endpoints (OpenRouter, LiteLLM,
  // Cloudflare AI Gateway). One shared base_url serves every listed adapter.
  // Declared LAST to match the live column order (added by migration 0002) —
  // drizzle-kit emits a table recreate when the declaration order drifts.
  adapters: text('adapters').notNull().default('["openai"]'),
});

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(), // globally unique platform id used by clients
    upstreamModel: text('upstream_model'),
    displayName: text('display_name'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    pricingInput: real('pricing_input'), // USD per 1M tokens
    pricingOutput: real('pricing_output'),
    capabilities: text('capabilities'), // JSON array
    fallbacks: text('fallbacks'), // JSON array of model slugs (ordered chain)
    baseUrlOverride: text('base_url_override'),
    apiKeyOverrideEnc: text('api_key_override_enc'),
    keyHint: text('key_hint'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // M10 per-model GLOBAL request-rate cap (requests/minute, shared across
    // all clients) — null = unlimited.
    rateLimitRpm: integer('rate_limit_rpm'),
    // M11 semantic cache opt-in for THIS model — responses to eligible
    // text-only requests are cached + replayed (gateway dedupe). Declared LAST
    // so generated migrations stay plain ALTER TABLE ADD COLUMNs.
    cacheEnabled: integer('cache_enabled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('models_slug_unique').on(t.slug),
    index('models_provider_idx').on(t.providerId),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(), // sha-256 hex; raw key is never stored
    keyPrefix: text('key_prefix').notNull(), // e.g. "khat-Ab3x"
    /** Owning portal user (M8): the account a personal key belongs to, or the
     * creator of an org key (attribution). null = admin-managed key. */
    userId: text('user_id'),
    /** Owning org (M9); null = personal/admin key. Org keys draw the ORG's
     * prepaid balance, not the creator's. */
    orgId: text('org_id'),
    spendLimitUsd: real('spend_limit_usd'),
    allowedModels: text('allowed_models'), // JSON array of slugs; empty/missing = all
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
    // M10 per-key request-rate override (requests/minute) — null = use the
    // deployment default (settings rate_limit_key_rpm).
    rateLimitRpm: integer('rate_limit_rpm'),
    // M11 semantic cache opt-in for THIS key — a key can turn caching on for
    // every model it calls (model-level opt-in is the other surface). Declared
    // LAST so generated migrations stay plain ALTER TABLE ADD COLUMNs.
    cacheEnabled: integer('cache_enabled', { mode: 'boolean' }).notNull().default(false),
    // M14 playground key: the admin-session id (sha256 of the session token)
    // this ephemeral key belongs to. null = a normal key. Playground keys are
    // minted by POST /admin/playground/key, hidden from the keys list, and die
    // with their session (logout) or when the session row disappears (sweep).
    playgroundSession: text('playground_session'),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.keyHash), index('api_keys_user_idx').on(t.userId), index('api_keys_org_idx').on(t.orgId)],
);

/**
 * Organizations / teams (M9). An org owns a shared prepaid balance
 * (`balance_usd_micros`, drawn by org-scoped API keys) and members with roles
 * (`org_members`). Join codes are the invite mechanism — Workers has no email
 * sender — so a member can share a code that self-serve users redeem in the
 * portal. Platform admin stays global (admins are not org members).
 */
export const orgs = sqliteTable(
  'orgs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    joinCode: text('join_code').notNull(), // invite code; owner can rotate it
    balanceUsdMicros: integer('balance_usd_micros').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('orgs_join_code_unique').on(t.joinCode)],
);

/**
 * Org membership (M9). Roles: 'owner' (manage members/keys/billing/the org
 * itself) and 'member' (create + manage own org keys, view org usage/logs and
 * balance). No FK declarations, matching the users-adjacent tables — deletes
 * are explicit batches in the routes.
 */
export const orgMembers = sqliteTable(
  'org_members',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(), // owner | member
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('org_members_org_user_unique').on(t.orgId, t.userId),
    index('org_members_user_idx').on(t.userId),
  ],
);

/**
 * Portal users (M8). Balance is prepaid credit held in micro-USD (1e-6 $;
 * integer math — per-request costs are far below one cent). Drawn down by
 * `balance_entries` usage debits; topped up via the MoR (Lemon Squeezy)
 * webhook. password_hash format: `pbkdf2-sha256:<iterations>:<salt-b64>:<hash-b64>`.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(), // stored lowercase
    passwordHash: text('password_hash').notNull(),
    balanceUsdMicros: integer('balance_usd_micros').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

/**
 * Portal sessions — same revocable pattern as the admin `sessions` table but
 * scoped to a user (logout deletes the row; admin can revoke all of a user's
 * sessions by user_id).
 */
export const userSessions = sqliteTable(
  'user_sessions',
  {
    // id = sha256 hex of the signed session token (revocable server-side)
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId)],
);

/**
 * Balance ledger. Exactly one of user_id (personal account, M8) or org_id
 * (shared org balance, M9) is set. delta_usd_micros: positive = credit
 * (topup / admin adjustment), negative = usage debit. `ref` is globally
 * unique where present (LS order id, request-log id, adjustment uuid) so a
 * replayed webhook or a re-run debit can never double-apply. The matching
 * users/orgs balance column is the materialized sum, updated in the same
 * D1 batch as each entry.
 */
export const balanceEntries = sqliteTable(
  'balance_entries',
  {
    id: text('id').primaryKey(),
    /** Personal-ledger owner (M8); null on org entries. */
    userId: text('user_id'),
    /** Org-ledger owner (M9); null on personal entries. */
    orgId: text('org_id'),
    deltaUsdMicros: integer('delta_usd_micros').notNull(),
    kind: text('kind').notNull(), // topup | usage | adjustment
    ref: text('ref'), // idempotency key (unique where present)
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('balance_entries_user_idx').on(t.userId),
    index('balance_entries_org_idx').on(t.orgId),
    uniqueIndex('balance_entries_ref_unique').on(t.ref),
  ],
);

/**
 * Inbound MoR webhook events, recorded for idempotency + audit. A duplicate
 * (source, event_key) insert fails → the webhook handler answers "duplicate"
 * without re-crediting.
 */
export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(), // 'lemonsqueezy'
    eventKey: text('event_key').notNull(), // provider event/order id
    eventName: text('event_name').notNull(),
    note: text('note'), // e.g. why no credit was applied
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('webhook_events_source_key_unique').on(t.source, t.eventKey)],
);

/**
 * Deployment-level key/value settings (admin-controlled gateway behavior).
 * Current rows: `client_key_enforcement` = 'on' | 'off' (absent = 'off', i.e.
 * the keyless-native default). Generic by design — future flags add rows,
 * not migrations.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  // id = sha256 hex of the signed session token (revocable server-side)
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: text('id').primaryKey(),
    apiKeyId: text('api_key_id'),
    /** Attributing portal account (M9): the key's user (owner for personal
     * keys, creator for org keys); null for admin/anonymous requests. */
    userId: text('user_id'),
    /** Owning org for org-scoped keys (M9); survives org deletion as the
     * audit trail (same policy as user attribution). */
    orgId: text('org_id'),
    modelSlug: text('model_slug').notNull(),
    providerId: text('provider_id'),
    upstreamModel: text('upstream_model'),
    dialect: text('dialect').notNull(), // chat | responses | messages
    status: integer('status').notNull(), // HTTP-ish status of the gateway response
    latencyMs: integer('latency_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'), // snapshot at request time
    error: text('error'), // short first error message, truncated
    // M11: 1 when the response was served from the semantic cache (no upstream
    // call) — the logs UI marks these and usage views aggregate the savings.
    cacheHit: integer('cache_hit', { mode: 'boolean' }).notNull().default(false),
    // M16 client attribution (OpenRouter HTTP-Referer/X-Title headers) — the
    // app a request came from. Never auth headers; audit trail only.
    httpReferer: text('http_referer'),
    xTitle: text('x_title'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('request_logs_created_idx').on(t.createdAt),
    index('request_logs_org_idx').on(t.orgId),
    index('request_logs_user_idx').on(t.userId),
    // M15: the spend-cap SUM, logs filter and per-key usage aggregates all
    // query by api_key_id on every keyed request — without this index each is
    // a full scan of the append-only log table.
    index('request_logs_api_key_idx').on(t.apiKeyId),
  ],
);

/**
 * Semantic cache (M11). One row per cached response: `key` = sha-256 hex over
 * a stable (key-sorted) JSON of the canonical request + resolved model slug —
 * dialect-independent, so the same prompt through /v1/chat/completions and
 * /v1/messages hits the same entry. `payload` keeps the RAW upstream JSON body
 * and `upstream` which adapter produced it, so a hit replays through the exact
 * same passthrough/translation path a miss would have taken. TTL is evaluated
 * lazily (`expires_at` vs now) and expired rows are swept on each store. Text
 * lives only for eligible (text-only, non-streaming) responses of cache-opted
 * models/keys while the deployment master switch is on.
 */
export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    key: text('key').primaryKey(), // sha-256 hex of the canonical request + model
    modelSlug: text('model_slug').notNull(), // resolved (requested) slug — flush/stats grouping
    upstream: text('upstream').notNull(), // 'openai' | 'anthropic' — who produced the payload
    providerId: text('provider_id'), // serving provider at store time (may dangle after deletion)
    providerName: text('provider_name').notNull(), // snapshot for hit headers (row may vanish)
    upstreamModel: text('upstream_model').notNull(),
    payload: text('payload').notNull(), // raw upstream JSON response body
    size: integer('size').notNull(), // payload byte length (stats / admission cap)
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('cache_entries_expires_idx').on(t.expiresAt), index('cache_entries_model_idx').on(t.modelSlug)],
);
