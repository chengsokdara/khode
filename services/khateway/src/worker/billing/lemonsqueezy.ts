// Lemon Squeezy (merchant of record) plumbing for M8 top-ups. Pure helpers:
// webhook signature verification + payload parsing/crediting math live here so
// the route handler stays thin and the logic is unit-testable offline.
//
// LS signs each webhook payload with HMAC-SHA256 (hex, lowercase) in the
// `X-Signature` header. `order_created` for a paid, non-refunded order credits
// the org found in `meta.custom_data.org_id` (M9 org top-ups) or, when absent,
// the user in `meta.custom_data.user_id` (personal) — both echoed from the
// checkout's `checkout_data.custom`. Credit amount = subtotal − discount_total
// (the product's pre-tax value; the MoR keeps the tax) with a fallback to
// `total`.
import { hmacVerify } from '../crypto';

/** Verifies the X-Signature header against the raw request body. */
export async function lsSignatureValid(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!signatureHeader) return false;
  return hmacVerify(secret, rawBody, signatureHeader.trim());
}

/** The subset of an LS webhook payload Khateway acts on. */
export interface LsWebhookEvent {
  eventName: string;
  /** Idempotency key: `<event_name>:<order|subscription id>`. */
  eventKey: string;
  orderId: string | null;
  /** meta.custom_data.user_id — the Khateway account to credit (personal). */
  userId: string | null;
  /** meta.custom_data.org_id — the org to credit (M9); takes precedence. */
  orgId: string | null;
  /** Order status ('paid' | 'pending' | 'refunded' | …). */
  status: string | null;
  refunded: boolean;
  currency: string | null;
  /** Cent amounts from the order (null when absent). */
  subtotalCents: number | null;
  discountCents: number | null;
  totalCents: number | null;
  userEmail: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Parses a webhook JSON body; returns null when it is not a usable LS event. */
export function parseLsWebhook(body: unknown): LsWebhookEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  const meta = root.meta as Record<string, unknown> | undefined;
  const data = root.data as Record<string, unknown> | undefined;
  const eventName = str(meta?.event_name);
  const eventId = str(data?.id);
  if (!eventName || !eventId) return null;

  const attrs = (data?.attributes ?? {}) as Record<string, unknown>;
  const custom = (meta?.custom_data ?? null) as Record<string, unknown> | null;

  return {
    eventName,
    eventKey: `${eventName}:${eventId}`,
    orderId: eventId,
    userId: custom && typeof custom === 'object' ? str(custom.user_id) : null,
    orgId: custom && typeof custom === 'object' ? str(custom.org_id) : null,
    status: str(attrs.status),
    refunded: attrs.refunded === true,
    currency: str(attrs.currency),
    subtotalCents: num(attrs.subtotal),
    discountCents: num(attrs.discount_total),
    totalCents: num(attrs.total),
    userEmail: str(attrs.user_email),
  };
}

/**
 * Micro-USD credit an order should grant (1e-6 $ integers — per-request costs
 * are far below one cent). Prepaid product value only: subtotal minus
 * discounts, falling back to the gross total when the breakdown is absent.
 * Zero for anything that is not a paid, non-refunded order.
 */
export function creditMicros(ev: LsWebhookEvent): number {
  if (ev.eventName !== 'order_created' || ev.status !== 'paid' || ev.refunded) return 0;
  let cents: number | null = null;
  if (ev.subtotalCents != null) {
    cents = ev.subtotalCents - (ev.discountCents ?? 0);
  } else {
    cents = ev.totalCents;
  }
  if (cents == null || !Number.isFinite(cents)) return 0;
  return Math.max(0, Math.round(cents * 10_000)); // cents → micros (×1e4)
}

// ------------------------------------------------------------------ checkout

export interface LsCheckoutInput {
  storeId: string;
  variantId: string;
  apiKey: string;
  /** Positive integer, USD cents (Lemon Squeezy pricing is cent-denominated). */
  amountUsdCents: number;
  userEmail: string;
  /** Rides through to the webhook as meta.custom_data.user_id (personal top-up). */
  userId?: string;
  /** Rides through as meta.custom_data.org_id (org top-up, M9) — wins over
   * userId in the webhook when both are present. */
  orgId?: string;
  /** Where LS sends the customer after payment (the portal billing page). */
  redirectUrl: string;
}

export type LsCheckoutResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Creates a hosted custom-price checkout for a one-off credit top-up.
 * API docs: POST /v1/checkouts with store + variant relationships.
 */
export async function createLsCheckout(input: LsCheckoutInput): Promise<LsCheckoutResult> {
  let res: Response;
  const custom: Record<string, string> = {};
  if (input.orgId) custom.org_id = input.orgId;
  else if (input.userId) custom.user_id = input.userId;
  try {
    res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: { USD: input.amountUsdCents },
            product_options: { redirect_url: input.redirectUrl },
            checkout_data: { email: input.userEmail, custom },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(input.storeId) } },
            variant: { data: { type: 'variants', id: String(input.variantId) } },
          },
        },
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error';
    return { ok: false, error: /abort|timeout/i.test(msg) ? 'Lemon Squeezy request timed out' : `Lemon Squeezy unreachable: ${msg}` };
  }

  const payload = (await res.json().catch(() => null)) as
    | { data?: { attributes?: { url?: unknown } }; message?: unknown; errors?: unknown }
    | null;
  if (!res.ok || !payload) {
    const detail =
      typeof payload?.message === 'string'
        ? payload.message
        : Array.isArray(payload?.errors) && payload.errors.length
          ? JSON.stringify(payload.errors[0])
          : `HTTP ${res.status}`;
    return { ok: false, error: `Lemon Squeezy checkout failed: ${detail}` };
  }
  const url = payload.data?.attributes?.url;
  if (typeof url !== 'string' || !url) {
    return { ok: false, error: 'Lemon Squeezy returned no checkout URL.' };
  }
  return { ok: true, url };
}
