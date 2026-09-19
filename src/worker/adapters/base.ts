// Shared upstream plumbing for the adapters (src/worker/adapters/):
// credential decryption, provider default-header merging, the concrete
// upstream request shape, and the timeout-guarded fetch. Split out of
// adapters/openai.ts in M4 when the anthropic adapter joined. Per RULES.md #7
// wire/translation logic stays in dialects/, adapters/ and routes/gateway*.
import type { Env } from '../env';
import type { RoutingCandidate } from '../routing';
import { decryptSecret } from '../crypto';

/** Provider/model credentials or configuration are unusable (mapped to a 500 by the gateway). */
export class UpstreamMisconfigError extends Error {}

/** The canonical request cannot be expressed in the target dialect (mapped to a 400 by the gateway). */
export class UnsupportedTranslationError extends Error {}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Request budget: upstream response headers must arrive within this. */
  timeoutMs: number;
}

export type UpstreamOutcome =
  | { kind: 'fetched'; res: Response; latencyMs: number }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string };

export function parseHeaderMap(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k && typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Decrypts the effective provider key (model-level override wins) or returns
 * null when the provider has none (Ollama/vLLM-style local upstreams). Throws
 * UpstreamMisconfigError when a stored key cannot be decrypted.
 */
export async function decryptProviderKey(env: Env, cand: RoutingCandidate): Promise<string | null> {
  const keyEnc = cand.model.apiKeyOverrideEnc ?? cand.provider.apiKeyEnc;
  if (!keyEnc) return null;
  try {
    return await decryptSecret(env, keyEnc);
  } catch {
    throw new UpstreamMisconfigError(
      `Stored API key for provider '${cand.provider.name}' is unreadable — is ENCRYPTION_KEY still the one it was encrypted with?`,
    );
  }
}

/**
 * Invokes an upstream request. Timeout applies to response *headers*; once
 * they arrive the timer is cleared so long SSE streams are never cut short by
 * it. Network failures and timeouts are reported; upstream HTTP status codes
 * are handed to the caller as a fetched Response.
 */
export async function invokeUpstream(req: UpstreamRequest): Promise<UpstreamOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    return { kind: 'fetched', res, latencyMs: Date.now() - t0 };
  } catch (e) {
    if (timedOut) return { kind: 'timeout' };
    return { kind: 'network', message: e instanceof Error ? e.message || 'network error' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}
