// Gateway routing: resolve the client `model` field (a platform slug like
// `gpt-5`, or provider-pinned `provider/slug`) to the (model, provider) pair
// that serves it. Since M6 the resolution also returns the model's ordered
// fallback chain (models.fallbacks) for the gateway's retry loop.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Adapter, Env } from './env';
import { DEFAULT_BASES } from './env';
import { KNOWN_ADAPTERS } from '../shared/adapters';
import { getDb } from './db';
import { models, providers } from './db/schema';

/** Parses + validates the providers.adapters JSON column into known adapters. */
export function parseAdapters(json: string | null): Adapter[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Adapter => typeof x === 'string' && (KNOWN_ADAPTERS as readonly string[]).includes(x));
  } catch {
    return [];
  }
}

/** Platform model-slug alphabet (also the importable upstream-id filter):
 * 1–120 chars of letters, digits, dots, dashes, underscores, first char
 * alphanumeric. Shared by models CRUD (admin), imports and the free-models
 * sync so the three never drift. */
export const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

/** Defensive parse + de-dup, preserving the provider's preference order. */
function providerAdapterList(raw: string): Adapter[] {
  const seen = new Set<Adapter>();
  for (const a of parseAdapters(raw)) seen.add(a);
  return [...seen];
}

/** A resolved (model, provider) pair, with effective values already merged. */
export interface RoutingCandidate {
  model: {
    id: string;
    slug: string;
    /** Effective upstream model name (model.upstreamModel || model.slug). */
    upstreamModel: string;
    baseUrlOverride: string | null;
    apiKeyOverrideEnc: string | null;
    /** Configured output cap; the anthropic adapter uses it to default the required max_tokens. */
    maxOutputTokens: number | null;
    /** USD per 1M tokens — the gateway snapshots per-request cost from these (M7). */
    pricingInput: number | null;
    pricingOutput: number | null;
    /** Ordered fallback slugs (may be `provider/slug` pins); resolved by resolveModelChain. */
    fallbacks: string[];
    /** M10 global per-model request-rate cap (req/min); null = unlimited. */
    rateLimitRpm: number | null;
    /** M11 semantic-cache opt-in for this model (OR'd with the key's flag at the gateway). */
    cacheEnabled: boolean;
    enabled: boolean;
  };
  provider: {
    id: string;
    name: string;
    /** Upstream dialects this provider speaks (≥1; gateway picks per request). */
    adapters: Adapter[];
    baseUrl: string | null;
    apiKeyEnc: string | null;
    defaultHeaders: string | null;
    timeoutMs: number | null;
    enabled: boolean;
  };
  /**
   * Base URL that serves EVERY provider adapter: model override → provider
   * base_url → first adapter's default. When the provider is dual-dialect the
   * value keeps openai's `/v1` convention; joinAdapterUrl strips it for the
   * anthropic path so one base URL serves both adapters.
   */
  baseUrl: string;
  /** Same URL resolution as `baseUrl` but with adapter-specific defaults. */
  effectiveBaseUrl: (adapter: Adapter) => string;
}

export type RoutingResolution =
  | { ok: true; candidate: RoutingCandidate }
  | { ok: false; status: number; message: string; code?: string };

const candidateFields = {
  modelId: models.id,
  slug: models.slug,
  upstreamModel: models.upstreamModel,
  baseUrlOverride: models.baseUrlOverride,
  apiKeyOverrideEnc: models.apiKeyOverrideEnc,
  maxOutputTokens: models.maxOutputTokens,
  pricingInput: models.pricingInput,
  pricingOutput: models.pricingOutput,
  fallbacks: models.fallbacks,
  rateLimitRpm: models.rateLimitRpm,
  cacheEnabled: models.cacheEnabled,
  modelEnabled: models.enabled,
  providerId: providers.id,
  providerName: providers.name,
  providerAdapters: providers.adapters,
  providerBaseUrl: providers.baseUrl,
  apiKeyEnc: providers.apiKeyEnc,
  defaultHeaders: providers.defaultHeaders,
  timeoutMs: providers.timeoutMs,
  providerEnabled: providers.enabled,
};

type CandidateRow = {
  modelId: string;
  slug: string;
  upstreamModel: string | null;
  baseUrlOverride: string | null;
  apiKeyOverrideEnc: string | null;
  maxOutputTokens: number | null;
  pricingInput: number | null;
  pricingOutput: number | null;
  fallbacks: string | null;
  rateLimitRpm: number | null;
  cacheEnabled: boolean;
  modelEnabled: boolean;
  providerId: string;
  providerName: string;
  providerAdapters: string;
  providerBaseUrl: string | null;
  apiKeyEnc: string | null;
  defaultHeaders: string | null;
  timeoutMs: number | null;
  providerEnabled: boolean;
};

/** Parses the models.fallbacks JSON column (array of slugs) defensively. */
function parseFallbacks(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 10);
  } catch {
    return [];
  }
}

function toCandidate(r: CandidateRow): RoutingCandidate {
  const adapters = providerAdapterList(r.providerAdapters);
  const primary = adapters[0] ?? 'openai';
  // One base URL serves every adapter: model override → provider base_url →
  // the first adapter's default. joinAdapterUrl fixes per-adapter /v1 shapes.
  const baseUrl = (r.baseUrlOverride || r.providerBaseUrl || DEFAULT_BASES[primary]).replace(/\/+$/, '');
  return {
    model: {
      id: r.modelId,
      slug: r.slug,
      upstreamModel: r.upstreamModel || r.slug,
      baseUrlOverride: r.baseUrlOverride,
      apiKeyOverrideEnc: r.apiKeyOverrideEnc,
      maxOutputTokens: r.maxOutputTokens,
      pricingInput: r.pricingInput,
      pricingOutput: r.pricingOutput,
      fallbacks: parseFallbacks(r.fallbacks),
      rateLimitRpm: r.rateLimitRpm,
      cacheEnabled: r.cacheEnabled,
      enabled: r.modelEnabled,
    },
    provider: {
      id: r.providerId,
      name: r.providerName,
      adapters,
      baseUrl: r.providerBaseUrl,
      apiKeyEnc: r.apiKeyEnc,
      defaultHeaders: r.defaultHeaders,
      timeoutMs: r.timeoutMs,
      enabled: r.providerEnabled,
    },
    baseUrl,
    effectiveBaseUrl: (adapter: Adapter) =>
      (r.baseUrlOverride || r.providerBaseUrl || DEFAULT_BASES[adapter]).replace(/\/+$/, ''),
  };
}

/** `"provider/slug"` → `{pin, slug}`; plain slugs have `pin: null`. */
export function splitPinnedModel(modelField: string): { pin: string | null; slug: string } {
  const slash = modelField.indexOf('/');
  if (slash === -1) return { pin: null, slug: modelField };
  return { pin: modelField.slice(0, slash), slug: modelField.slice(slash + 1) };
}

const notFound = (message: string): RoutingResolution => ({
  ok: false,
  status: 404,
  message,
  code: 'model_not_found',
});

/**
 * Resolves a client `model` field to the route that serves it.
 * Plain slug → globally unique model row. `provider/slug` pin → that model on
 * the named provider (provider id or name, case-insensitive fallback).
 */
export async function resolveModelRoute(env: Env, modelField: string): Promise<RoutingResolution> {
  const db = getDb(env);
  const { pin, slug } = splitPinnedModel(modelField);

  let row: CandidateRow | undefined;
  if (pin) {
    // Pin by provider id first, then exact name, then case-insensitive name.
    const pick = { id: providers.id };
    let provider: { id: string } | undefined = (
      await db.select(pick).from(providers).where(eq(providers.id, pin))
    )[0];
    if (!provider) provider = (await db.select(pick).from(providers).where(eq(providers.name, pin)))[0];
    if (!provider) {
      const lower = await db
        .select(pick)
        .from(providers)
        .where(sql`lower(${providers.name}) = ${pin.toLowerCase()}`)
        .orderBy(asc(providers.createdAt));
      provider = lower[0];
    }
    if (!provider) {
      return notFound(`Unknown provider '${pin}' in pinned model '${modelField}'.`);
    }
    row = (
      await db.select(candidateFields).from(models).innerJoin(providers, eq(models.providerId, providers.id))
        .where(and(eq(models.slug, slug), eq(models.providerId, provider.id)))
    )[0];
    if (!row) return notFound(`Provider '${pin}' has no model with slug '${slug}'.`);
  } else {
    row = (
      await db.select(candidateFields).from(models).innerJoin(providers, eq(models.providerId, providers.id))
        .where(eq(models.slug, slug))
    )[0];
    if (!row) return notFound(`The model '${modelField}' does not exist or you do not have access to it.`);
  }

  if (!row.modelEnabled || !row.providerEnabled) {
    return notFound(
      `Model '${modelField}' exists in Khateway but is disabled${!row.providerEnabled ? ' (its provider is disabled too)' : ''} — enable it in the admin console.`,
    );
  }
  return { ok: true, candidate: toCandidate(row) };
}

export type ModelChainResolution =
  | { ok: true; candidate: RoutingCandidate; fallbacks: RoutingCandidate[] }
  | { ok: false; status: number; message: string; code?: string };

/**
 * Resolves a client `model` field to its serving route plus the model's
 * ordered fallback chain (models.fallbacks). Each fallback entry resolves
 * like a `model` field (slug or `provider/slug` pin, so chains may cross
 * providers/adapters); unknown, disabled or already-visited entries are
 * skipped. The chain is capped at 10 entries (matching the admin CRUD limit).
 */
export async function resolveModelChain(env: Env, modelField: string): Promise<ModelChainResolution> {
  const primary = await resolveModelRoute(env, modelField);
  if (!primary.ok) return primary;
  const visited = new Set<string>([primary.candidate.model.id]);
  const fallbacks: RoutingCandidate[] = [];
  for (const entry of primary.candidate.model.fallbacks) {
    if (fallbacks.length >= 10) break;
    const res = await resolveModelRoute(env, entry);
    if (!res.ok) continue;
    if (visited.has(res.candidate.model.id)) continue;
    visited.add(res.candidate.model.id);
    fallbacks.push(res.candidate);
  }
  return { ok: true, candidate: primary.candidate, fallbacks };
}
