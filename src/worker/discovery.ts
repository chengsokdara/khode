// Upstream model discovery: probes a provider's /models listing per adapter
// and normalizes it into UpstreamModel entries. Lifted out of routes/admin.ts
// (unchanged behavior) so the free-models sync (models-sync.ts) and the admin
// fetch-models routes share ONE implementation without route→route imports.
import type { Adapter, Env } from './env';
import { DEFAULT_BASES, joinAdapterUrl } from './env';
import { decryptSecret } from './crypto';
import { parseAdapters } from './routing';
import type { providers } from './db/schema';

export type ProviderRow = typeof providers.$inferSelect;

/**
 * One upstream model as offered for import into the Khateway catalog.
 * pricing* is captured when the listing exposes per-token USD price strings
 * (OpenRouter-style `pricing.prompt`/`pricing.completion`), already converted
 * to USD per 1M tokens (the models table unit); null = the listing carries no
 * pricing (plain OpenAI/Anthropic/Gemini listings) — NOT the same as 0.
 */
export interface UpstreamModel {
  id: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricingInput: number | null;
  pricingOutput: number | null;
}

export const UPSTREAM_MODELS_MAX = 500;

export type UpstreamModelsResult = { ok: true; models: UpstreamModel[] } | { ok: false; error: string; status: number | null };

/** Parses an OpenRouter-style per-token USD price ("0", "0.0000015") into USD
 * per 1M tokens ("0" → 0 = free); anything non-numeric/negative → null
 * (no pricing rather than a made-up one). */
export function perTokenToPerMillion(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

function parseHeadersJson(s: string | null | undefined): Record<string, string> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Probes ONE adapter's /models listing (openai-compatible: GET /models;
 * anthropic: GET /v1/models; gemini: GET /models over /v1beta) with the
 * provider's effective base URL, credentials and default headers, and
 * normalizes the result into UpstreamModel entries. Best-effort: entries with
 * unusable ids are skipped; a provider without a stored base URL rides the
 * adapter default (same fallback the connection test uses).
 */
export async function listUpstreamModelsForAdapter(env: Env, p: ProviderRow, adapter: Adapter): Promise<UpstreamModelsResult> {
  let key: string | null = null;
  try {
    key = await decryptSecret(env, p.apiKeyEnc);
  } catch (e) {
    return { ok: false, status: null, error: `Stored API key unreadable: ${e instanceof Error ? e.message : 'decrypt failed'}` };
  }

  const isAnthropic = adapter === 'anthropic';
  const isGemini = adapter === 'gemini';
  const base = (p.baseUrl ?? DEFAULT_BASES[adapter]).replace(/\/+$/, '');
  const url = joinAdapterUrl(base, adapter, isAnthropic ? '/v1/models' : '/models');
  const headers: Record<string, string> = {
    ...(parseHeadersJson(p.defaultHeaders) ?? {}),
    ...(isAnthropic
      ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
      : isGemini
        ? { 'x-goog-api-key': key ?? '' }
        : key
          ? { Authorization: `Bearer ${key}` }
          : {}),
  };

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(1_500, p.timeoutMs ?? 8_000))),
    });
    if (!res.ok) {
      const errBody = (await res.text().catch(() => '')).slice(0, 240);
      return { ok: false, status: res.status, error: errBody || `HTTP ${res.status}` };
    }
    if (isGemini) {
      // Gemini listing: {models:[{name:'models/gemini-2.5-flash', displayName,
      // inputTokenLimit, outputTokenLimit, supportedGenerationMethods}]} — ids
      // are the stripped names; non-generateContent entries (embeddings, tts…)
      // are skipped since the gateway only routes chat generation.
      const body = (await res.json().catch(() => null)) as { models?: unknown } | null;
      if (!body || !Array.isArray(body.models)) {
        return { ok: false, status: res.status, error: 'Upstream returned an unexpected /models response (no models array).' };
      }
      const models: UpstreamModel[] = [];
      const seen = new Set<string>();
      for (const raw of body.models) {
        if (!raw || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        const id = typeof m.name === 'string' ? m.name.trim().replace(/^models\//, '') : '';
        if (!id || seen.has(id)) continue;
        const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : null;
        if (methods && !methods.includes('generateContent')) continue;
        seen.add(id);
        const ctx = typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null;
        const out = typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : null;
        const name = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : null;
        models.push({ id, displayName: name, contextWindow: ctx, maxOutputTokens: out, pricingInput: null, pricingOutput: null });
        if (models.length >= UPSTREAM_MODELS_MAX) break;
      }
      return { ok: true, models };
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      return { ok: false, status: res.status, error: 'Upstream returned an unexpected /models response (no data array).' };
    }
    const models: UpstreamModel[] = [];
    const seen = new Set<string>();
    for (const raw of body.data) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ctx = typeof m.context_window === 'number' ? m.context_window : typeof m.context_length === 'number' ? m.context_length : null;
      // OpenRouter-style listings nest the output cap in top_provider.max_completion_tokens.
      const tp = (m.top_provider ?? null) as Record<string, unknown> | null;
      const out =
        typeof m.max_output_tokens === 'number' ? m.max_output_tokens
        : tp && typeof tp.max_completion_tokens === 'number' ? tp.max_completion_tokens
        : null;
      const name = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : null;
      // OpenRouter-style listings carry per-token USD price strings.
      const pricing = (m.pricing ?? null) as Record<string, unknown> | null;
      models.push({
        id,
        displayName: name,
        contextWindow: ctx,
        maxOutputTokens: out,
        pricingInput: pricing ? perTokenToPerMillion(pricing.prompt) : null,
        pricingOutput: pricing ? perTokenToPerMillion(pricing.completion) : null,
      });
      if (models.length >= UPSTREAM_MODELS_MAX) break;
    }
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    return { ok: false, status: null, error: /abort|timeout/i.test(msg) ? 'Timed out fetching models' : msg };
  }
}

/**
 * Legacy single-probe wrapper: probes the provider's FIRST declared adapter
 * (client-dialect-agnostic — the shape the admin import picker has always
 * used). The sync probes every declared adapter via listUpstreamModelsForAdapter.
 */
export async function listUpstreamModels(env: Env, p: ProviderRow): Promise<UpstreamModelsResult> {
  const adapters = parseAdapters(p.adapters);
  return listUpstreamModelsForAdapter(env, p, adapters[0] ?? 'openai');
}
