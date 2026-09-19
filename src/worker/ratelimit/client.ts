// Gateway-side rate-limit plumbing (M10): the pure check builder (fixture-
// tested offline) plus the fail-open DO client. The GATEWAY must never become
// unavailable because its rate limiter is — a DO error answers null and the
// caller skips enforcement entirely (same stance as the settings fail-open).
import type { Env } from '../env';
import type { RateCheck, RateLimitDecision } from './do';

/** One-minute fixed windows everywhere in M10. */
export const RATE_WINDOW_MS = 60_000;

export interface RateLimitSettings {
  enabled: boolean;
  /** Per-key default (requests/minute); keys may override via api_keys.rate_limit_rpm. */
  keyRpm: number;
  /** Anonymous per-IP default (requests/minute). */
  ipRpm: number;
}

export interface RateLimitInput {
  settings: RateLimitSettings;
  /** Resolved client key (null = anonymous — enforcement-off traffic included). */
  key: { id: string; rateLimitRpm: number | null } | null;
  /** Client IP (cf-connecting-ip; 'unknown' in dev). Only anonymous requests hit this bucket. */
  ip: string;
  /** Resolved primary model slug. */
  modelSlug: string;
  /** models.rate_limit_rpm on the resolved model (null = unlimited). */
  modelRpm: number | null;
}

/**
 * Builds the buckets to increment for one gateway request. Rules:
 * - settings disabled → no checks at all (zero DO round-trips).
 * - keyed request → `key:<id>` bucket at the key's override or the deployment
 *   default (its identity is already bounded; it never touches the IP bucket —
 *   shared egress IPs must not punish legitimate heavy keys).
 * - anonymous request → `ip:<ip>` bucket at the IP default (keyless-native
 *   traffic is exactly the abuse surface M10 exists for).
 * - model with a rate_limit_rpm → global `model:<slug>` bucket, shared across
 *   ALL clients (protects a hot upstream, not a single abuser).
 * A non-positive limit means "no limit" for that bucket.
 */
export function buildGatewayRateChecks(input: RateLimitInput): RateCheck[] {
  const { settings, key, ip, modelSlug, modelRpm } = input;
  if (!settings.enabled) return [];
  const checks: RateCheck[] = [];
  if (key) {
    const limit = key.rateLimitRpm ?? settings.keyRpm;
    if (limit >= 1) checks.push({ kind: 'key', scope: `key:${key.id}`, limit, windowMs: RATE_WINDOW_MS });
  } else if (settings.ipRpm >= 1) {
    checks.push({ kind: 'ip', scope: `ip:${ip}`, limit: settings.ipRpm, windowMs: RATE_WINDOW_MS });
  }
  if (modelRpm != null && modelRpm >= 1) {
    checks.push({ kind: 'model', scope: `model:${modelSlug}`, limit: modelRpm, windowMs: RATE_WINDOW_MS });
  }
  return checks;
}

/**
 * Increments every bucket through the singleton DO ("global") in ONE
 * round-trip. Returns null on ANY failure (DO unreachable, malformed answer) —
 * fail-open, the gateway keeps serving. Rejections log to console for ops.
 */
export async function checkRateLimits(env: Env, checks: RateCheck[]): Promise<RateLimitDecision[] | null> {
  if (checks.length === 0) return null;
  try {
    const id = env.RATE_LIMITER.idFromName('global');
    const res = await env.RATE_LIMITER.get(id).fetch('https://rate-limiter.internal/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checks }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { results?: RateLimitDecision[] };
    if (!Array.isArray(body.results) || body.results.length !== checks.length) {
      throw new Error('malformed rate-limiter response');
    }
    return body.results;
  } catch (e) {
    console.error('[ratelimit] check failed — failing open:', e);
    return null;
  }
}
