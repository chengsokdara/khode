// Semantic cache (M11) — D1 half: lookup, store (with expired-row sweep),
// flush and stats over the `cache_entries` table. Every function is
// defensive: a cache problem must never break a request that the gateway
// could otherwise serve (lookup/store failures degrade to MISS silently).
import { and, count, eq, gt, gte, lt, sql, sum } from 'drizzle-orm';
import type { Env } from '../env';
import { getDb } from '../db';
import { cacheEntries, requestLogs } from '../db/schema';

/** Bodies larger than this are not cached (text-only completions sit well under it). */
export const MAX_CACHE_PAYLOAD_BYTES = 512 * 1024;

/** A row from cache_entries (drizzle select shape). */
export type CacheEntryRow = typeof cacheEntries.$inferSelect;

/**
 * Returns the live (unexpired) entry for `key`, or null on miss/error.
 * Fail-open: a DB hiccup is indistinguishable from a miss.
 */
export async function lookupCacheEntry(env: Env, key: string): Promise<CacheEntryRow | null> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(cacheEntries)
      .where(and(eq(cacheEntries.key, key), gt(cacheEntries.expiresAt, Date.now())));
    return row ?? null;
  } catch {
    return null;
  }
}

export interface StoreCacheEntryInput {
  key: string;
  modelSlug: string;
  /** Which upstream adapter produced the payload ('openai' | 'anthropic' | 'gemini'). */
  upstream: string;
  providerId: string | null;
  providerName: string;
  upstreamModel: string;
  /** Raw upstream JSON body (from a clone() branch — read here, off the hot path). */
  body: ReadableStream<Uint8Array> | null;
  ttlSeconds: number;
}

function looksLikeUpstreamError(payload: Record<string, unknown>): boolean {
  // Some vendors answer 200 with an embedded error object (the z.ai /models
  // pattern) — never cache those; the next caller should reach the upstream.
  return 'error' in payload && payload.error != null;
}

/**
 * Reads the cloned upstream body, validates it and inserts the entry, sweeping
 * expired rows in the same batch. Runs under waitUntil — it must never delay
 * or fail the client-facing response, hence the blanket catch.
 */
export async function storeCacheEntry(env: Env, input: StoreCacheEntryInput): Promise<void> {
  try {
    if (!input.body) return;
    const text = await new Response(input.body).text();
    if (text.length > MAX_CACHE_PAYLOAD_BYTES) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return; // non-JSON body — nothing replayable
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (looksLikeUpstreamError(payload as Record<string, unknown>)) return;

    const now = Date.now();
    const db = getDb(env);
    await db.batch([
      db.delete(cacheEntries).where(lt(cacheEntries.expiresAt, now)),
      db
        .insert(cacheEntries)
        .values({
          key: input.key,
          modelSlug: input.modelSlug,
          upstream: input.upstream,
          providerId: input.providerId,
          providerName: input.providerName,
          upstreamModel: input.upstreamModel,
          payload: text,
          size: text.length,
          createdAt: now,
          expiresAt: now + Math.max(1, Math.floor(input.ttlSeconds)) * 1000,
        })
        .onConflictDoNothing({ target: cacheEntries.key }),
    ]);
  } catch (e) {
    console.error('[cache] store failed:', e);
  }
}

/** Admin flush: deletes every entry, returning how many were removed. */
export async function flushCache(env: Env): Promise<number> {
  const db = getDb(env);
  const [before] = await db.select({ n: count() }).from(cacheEntries);
  await db.delete(cacheEntries);
  return before?.n ?? 0;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  /** Cached responses served in the last 24 h (request_logs.cache_hit). */
  hits_24h: number;
  /** Tokens served from cache in the last 24 h (tokens in + out of hit rows). */
  tokens_cached_24h: number;
}

/** Admin stats: table size + the 24 h savings view from request_logs. */
export async function cacheStats(env: Env): Promise<CacheStats> {
  const db = getDb(env);
  const [e] = await db.select({ n: count(), bytes: sum(cacheEntries.size) }).from(cacheEntries);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const [h] = await db
    .select({
      hits: count(),
      tokens: sql<number>`coalesce(sum(${requestLogs.tokensIn}), 0) + coalesce(sum(${requestLogs.tokensOut}), 0)`,
    })
    .from(requestLogs)
    .where(and(eq(requestLogs.cacheHit, true), gte(requestLogs.createdAt, dayAgo)));
  return {
    entries: e?.n ?? 0,
    bytes: e?.bytes != null ? Number(e.bytes) : 0,
    hits_24h: h?.hits ?? 0,
    tokens_cached_24h: Number(h?.tokens ?? 0),
  };
}
