// Typed client for the /admin API + shared DTO types.

export type Adapter = 'openai' | 'anthropic' | 'gemini';

export const ADAPTER_LABELS: Record<Adapter, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Gemini (native)',
};

export const ADAPTER_DEFAULTS: Record<Adapter, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export const ADAPTER_HINTS: Record<Adapter, string> = {
  openai: 'Covers OpenAI, Groq, DeepSeek, xAI, OpenRouter, Gemini-compat, Ollama…',
  anthropic: 'Anthropic Messages API — also works for Anthropic-compatible proxies.',
  gemini: 'Native generateContent upstream — every client dialect is translated.',
};

export const CAPABILITIES = ['streaming', 'tools', 'vision', 'reasoning', 'json'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Provider {
  id: string;
  name: string;
  /** Legacy scalar (first adapter) — kept for compatibility. */
  adapter: Adapter;
  /** All upstream dialects this provider speaks; dual-dialect endpoints list both. */
  adapters: Adapter[];
  base_url: string | null;
  key_hint: string | null;
  default_headers: Record<string, string> | null;
  timeout_ms: number | null;
  enabled: boolean;
  model_count: number;
}

export interface ModelRow {
  id: string;
  provider_id: string;
  provider_name: string;
  provider_adapter: Adapter;
  provider_adapters: Adapter[];
  slug: string;
  upstream_model: string | null;
  display_name: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  pricing_input: number | null;
  pricing_output: number | null;
  capabilities: string[];
  fallbacks: string[];
  /** M10 global per-model rate cap (req/min); null = unlimited. */
  rate_limit_rpm: number | null;
  /** M11 semantic-cache opt-in for this model. */
  cache_enabled: boolean;
  base_url_override: string | null;
  key_hint: string | null;
  enabled: boolean;
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  latency_ms: number | null;
  model_count: number | null;
  error?: string;
}

/** One upstream model offered by the provider's /models listing. */
export interface UpstreamModel {
  id: string;
  display_name: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
}

export interface ImportResult {
  created: string[];
  skipped: { id: string; reason: string }[];
}

export interface Overview {
  providers: number;
  providers_enabled: number;
  models: number;
  models_enabled: number;
  api_keys: number;
  usage_24h: {
    requests: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    /** M11: of these requests, how many were served from the semantic cache. */
    cached: number;
  };
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  spend_limit_usd: number | null;
  /** M10 per-key rate-limit override (req/min); null = deployment default. */
  rate_limit_rpm: number | null;
  /** M11 semantic-cache opt-in for this key. */
  cache_enabled: boolean;
  allowed_models: string[];
  enabled: boolean;
  last_used_at: number | null;
  created_at: number;
  spent_usd: number;
  request_count: number;
  /** Only present on the create response — the raw key is never stored. */
  key?: string;
}

/** Session-scoped playground key (M14) — raw material returned once per mint. */
export interface PlaygroundKey {
  id: string;
  name: string;
  key_prefix: string;
  key: string;
}

export interface LogRow {
  id: string;
  api_key_id: string | null;
  key_name: string | null;
  model_slug: string;
  provider_id: string | null;
  provider_name: string | null;
  upstream_model: string | null;
  dialect: 'chat' | 'responses' | 'messages' | 'embeddings';
  status: number;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** M11: response was served from the semantic cache (no upstream call). */
  cache_hit: boolean;
  error: string | null;
  created_at: number;
}

export interface LogFilter {
  api_key_id?: string;
  model?: string;
  dialect?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface GatewaySettings {
  /** 'off' (default) = keyless-native: anonymous /v1 traffic is served. 'on' = a valid client key is required. */
  client_key_enforcement: 'on' | 'off';
  /** 'on' (default) = anonymous portal signups allowed. 'off' = existing accounts only. */
  public_signup: 'on' | 'off';
  /** M10 gateway rate limiting: 'on' (default) enforces per-key / per-IP /
   * per-model request caps; 'off' disables every bucket. */
  rate_limit_enabled: 'on' | 'off';
  /** Default per-key requests/minute (keys may override); default 120. */
  rate_limit_key_rpm: number;
  /** Anonymous per-IP requests/minute; default 60. */
  rate_limit_ip_rpm: number;
  /** M11 semantic cache: 'on' enables caching for opted-in models/keys. */
  cache_enabled: 'on' | 'off';
  /** Cached-entry lifetime in seconds (1–2592000); default 3600. */
  cache_ttl_seconds: number;
}

export interface PortalUserRow {
  id: string;
  email: string;
  balance_usd: number;
  enabled: boolean;
  key_count: number;
  created_at: number;
}

/** Organization / team (M9). Admin view is global — members are managed by org owners in the portal. */
export interface OrgRow {
  id: string;
  name: string;
  join_code: string;
  balance_usd: number;
  enabled: boolean;
  member_count: number;
  key_count: number;
  created_at: number;
  updated_at: number;
}

export interface BillingConfigInfo {
  provider: string;
  store_id: string | null;
  variant_id: string | null;
  api_key_hint: string | null;
  webhook_secret_set: boolean;
  configured: boolean;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  /** Cached responses served in the last 24 h. */
  hits_24h: number;
  /** Tokens (in + out) served from cache in the last 24 h. */
  tokens_cached_24h: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let playgroundKeyInflight: Promise<PlaygroundKey> | null = null;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (res.status === 401 && !url.includes('/login')) {
    window.dispatchEvent(new CustomEvent('khateway:unauthorized'));
    throw new ApiError('Session expired — sign in again.', 401);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON error body — handled below
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `Request failed (HTTP ${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  login: (password: string) => req<{ ok: boolean }>('/admin/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: boolean }>('/admin/logout', { method: 'POST' }),

  overview: () => req<Overview>('/admin/overview'),
  providers: () => req<Provider[]>('/admin/providers'),
  createProvider: (p: Record<string, unknown>) => req<Provider>('/admin/providers', { method: 'POST', body: JSON.stringify(p) }),
  updateProvider: (id: string, p: Record<string, unknown>) => req<Provider>(`/admin/providers/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/admin/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) => req<TestResult>(`/admin/providers/${id}/test`, { method: 'POST' }),
  /** Model discovery for a saved provider (uses its stored key). */
  fetchProviderModels: (id: string) =>
    req<{ models: UpstreamModel[] }>(`/admin/providers/${id}/fetch-models`, { method: 'POST' }),
  /** Model discovery with unsaved form values (key used in-memory only). */
  fetchModelsPreview: (p: Record<string, unknown>) =>
    req<{ models: UpstreamModel[] }>('/admin/providers/fetch-models', { method: 'POST', body: JSON.stringify(p) }),
  importModels: (id: string, modelIds: string[]) =>
    req<ImportResult>(`/admin/providers/${id}/import-models`, {
      method: 'POST',
      body: JSON.stringify({ model_ids: modelIds }),
    }),

  models: (providerId?: string) =>
    req<ModelRow[]>(`/admin/models${providerId ? `?provider_id=${encodeURIComponent(providerId)}` : ''}`),
  createModel: (m: Record<string, unknown>) => req<ModelRow>('/admin/models', { method: 'POST', body: JSON.stringify(m) }),
  updateModel: (id: string, m: Record<string, unknown>) => req<ModelRow>(`/admin/models/${id}`, { method: 'PATCH', body: JSON.stringify(m) }),
  deleteModel: (id: string) => req<{ ok: boolean }>(`/admin/models/${id}`, { method: 'DELETE' }),

  apiKeys: () => req<ApiKey[]>('/admin/api-keys'),
  settings: () => req<GatewaySettings>('/admin/settings'),
  updateSettings: (s: Partial<GatewaySettings>) => req<GatewaySettings>('/admin/settings', { method: 'PATCH', body: JSON.stringify(s) }),
  createApiKey: (k: Record<string, unknown>) => req<ApiKey>('/admin/api-keys', { method: 'POST', body: JSON.stringify(k) }),
  updateApiKey: (id: string, k: Record<string, unknown>) => req<ApiKey>(`/admin/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify(k) }),
  deleteApiKey: (id: string) => req<{ ok: boolean }>(`/admin/api-keys/${id}`, { method: 'DELETE' }),

  logs: (f: LogFilter = {}) => {
    const p = new URLSearchParams();
    if (f.api_key_id) p.set('api_key_id', f.api_key_id);
    if (f.model) p.set('model', f.model);
    if (f.dialect) p.set('dialect', f.dialect);
    if (f.status) p.set('status', f.status);
    if (f.limit) p.set('limit', String(f.limit));
    if (f.offset) p.set('offset', String(f.offset));
    const qs = p.toString();
    return req<LogRow[]>(`/admin/logs${qs ? `?${qs}` : ''}`);
  },
  clearLogs: () => req<{ ok: boolean }>('/admin/logs', { method: 'DELETE' }),

  // M11 — semantic cache stats + flush
  cacheStats: () => req<CacheStats>('/admin/cache'),
  flushCache: () => req<{ ok: boolean; flushed: number }>('/admin/cache/flush', { method: 'POST' }),

  // M14 — playground session key. Every mint rotates the session's key; the
  // inflight dedupe keeps React StrictMode's double-mount from minting twice
  // (both mounts must share one key, since mint #2 would revoke mint #1's).
  createPlaygroundKey: (): Promise<PlaygroundKey> => {
    if (!playgroundKeyInflight) {
      playgroundKeyInflight = req<PlaygroundKey>('/admin/playground/key', { method: 'POST' }).finally(() => {
        playgroundKeyInflight = null;
      });
    }
    return playgroundKeyInflight;
  },

  // M8 — portal accounts + MoR billing
  users: () => req<PortalUserRow[]>('/admin/users'),
  updateUser: (id: string, patch: Record<string, unknown>) =>
    req<PortalUserRow>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: string) => req<{ ok: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
  billingConfig: () => req<BillingConfigInfo>('/admin/billing/config'),
  updateBillingConfig: (patch: Record<string, unknown>) =>
    req<BillingConfigInfo>('/admin/billing/config', { method: 'PATCH', body: JSON.stringify(patch) }),

  // M9 — orgs / teams (admin is global: sees and manages every org)
  orgs: () => req<OrgRow[]>('/admin/orgs'),
  updateOrg: (id: string, patch: Record<string, unknown>) =>
    req<OrgRow>(`/admin/orgs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteOrg: (id: string) => req<{ ok: boolean }>(`/admin/orgs/${id}`, { method: 'DELETE' }),
};
