// Khateway — AI model router. One Worker serves the admin SPA (static assets),
// the /v1 gateway and the /admin console API.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Cross-isolate rate-limit counters (M10) — singleton DO, SQLite-backed. */
  RATE_LIMITER: DurableObjectNamespace;
  ADMIN_PASSWORD: string;
  /** 32 raw bytes, base64-encoded: `openssl rand -base64 32` */
  ENCRYPTION_KEY: string;
  /** Optional separate HMAC secret for session cookies (falls back to ENCRYPTION_KEY). */
  SESSION_SECRET?: string;
  /** Portal captcha. Both must be set or the check stays off. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

import type { Adapter } from '../shared/adapters';

export type { Adapter };

export const DEFAULT_BASES: Record<Adapter, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * Joins an adapter path onto a base URL shared by several adapters. Dual-
 * dialect providers configure ONE base URL; the openai adapter convention
 * includes `/v1` (→ `/chat/completions`) while anthropic appends the full
 * `/v1/messages` from the bare origin. Both paste styles work for BOTH
 * adapters:
 *   - base's LAST segment is exactly `v1` → kept as-is for openai
 *     (`/v1/chat/completions`), stripped for anthropic (`/v1/messages` —
 *     no `/v1/v1` doubling). Works for both `origin/v1` and
 *     `origin/api/v1`-style bases.
 *   - bare origin (no path at all) → kept as-is for anthropic
 *     (`/v1/messages`), and `/v1` is inserted for openai
 *     (`/v1/chat/completions`). The insertion is deliberately conservative:
 *     only when the base has NO path — vendor bases with a custom path
 *     (`/api/coding/paas/v4`, `/v1beta/openai`) must never gain `/v1`.
 * Gemini (M12): the generateContent paths are `/v1beta/models/{model}:…`, so
 * a bare origin gains `/v1beta` (mirroring the openai rule) while any pasted
 * path — `…/v1beta`, `…/v1beta/openai` or a proxy path — is kept verbatim.
 * The paths themselves carry the model + action (`:generateContent`), so the
 * anthropic-style `/v1`-strip rule does not apply here.
 */
export function joinAdapterUrl(base: string, adapter: Adapter, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (adapter === 'anthropic' && /\/v1$/i.test(trimmed)) {
    return joinUrl(trimmed.slice(0, -3), path);
  }
  if (adapter === 'openai' && /^https?:\/\/[^/]+$/i.test(trimmed)) {
    return joinUrl(`${trimmed}/v1`, path);
  }
  if (adapter === 'gemini' && /^https?:\/\/[^/]+$/i.test(trimmed)) {
    return joinUrl(`${trimmed}/v1beta`, path);
  }
  return joinUrl(trimmed, path);
}
