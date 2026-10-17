/**
 * P3: same-candidate retry + pacing for transient upstream failures inside
 * the fallback loops (chat + embeddings). A 429/5xx from an upstream is
 * usually transient: the pipelines retry the SAME upstream ONCE after a
 * computed wait before falling through to the next adapter/candidate, so one
 * upstream blip no longer burns a fallback slot (or the whole chain).
 *
 * Waits are strictly budgeted: a gateway request shares wall-clock with the
 * client's patience, so one wait never exceeds MAX_SINGLE_WAIT_MS and all
 * waits in one request never exceed MAX_TOTAL_WAIT_MS. A Retry-After that
 * exceeds the single-wait cap is treated as "this upstream is out for a
 * while" — fall through immediately instead of pretending to wait. Timeout
 * and network outcomes never retry the same upstream (they already burned
 * their latency budget); only response-shaped failures (429/5xx) do.
 */

export const MAX_SINGLE_WAIT_MS = 4_000;
export const MAX_TOTAL_WAIT_MS = 8_000;

/**
 * Parses a Retry-After header value (delta-seconds or HTTP-date) into
 * seconds; null when absent, empty or unparseable. A date in the past → 0.
 */
export function parseRetryAfterSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) {
    const v = Number(s);
    return v >= 0 ? v : null;
  }
  if (s.startsWith('-')) return null; // '-3' parses as a year — not a date
  const date = Date.parse(s);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** What the pipeline should do after one retryable upstream failure. */
export interface RetryDecision {
  /** Ms to sleep before the retry (0 = retry immediately). */
  waitMs: number;
  /** Retry the SAME upstream; false = fall through to the next adapter/candidate. */
  retrySame: boolean;
}

/**
 * Decision after one retryable upstream failure (429/5xx). `attempt` is the
 * 0-based retry index for THIS upstream (0 = first failure). 429 honors the
 * upstream Retry-After when it fits the single-wait cap (delta-seconds or
 * HTTP-date), else backs off exponentially from 500 ms; 5xx backs off
 * exponentially from 250 ms. The total-wait budget can end the retries.
 */
export function retryDecision(input: {
  status: number;
  retryAfterHeader: string | null;
  attempt: number;
  totalWaitedMs: number;
}): RetryDecision {
  const budgetLeft = MAX_TOTAL_WAIT_MS - input.totalWaitedMs;
  if (budgetLeft <= 0) return { waitMs: 0, retrySame: false };

  let waitMs: number;
  if (input.status === 429) {
    const ra = parseRetryAfterSeconds(input.retryAfterHeader);
    if (ra != null) {
      if (ra * 1000 > MAX_SINGLE_WAIT_MS) return { waitMs: 0, retrySame: false };
      waitMs = ra * 1000;
    } else {
      waitMs = Math.min(500 * 2 ** input.attempt, MAX_SINGLE_WAIT_MS);
    }
  } else {
    waitMs = Math.min(250 * 2 ** input.attempt, MAX_SINGLE_WAIT_MS);
  }
  waitMs = Math.min(waitMs, budgetLeft);
  return { waitMs: Math.max(0, Math.round(waitMs)), retrySame: true };
}

/** Sleep helper (setTimeout exists in workers and Node alike). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
