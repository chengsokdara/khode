// Typed client for the /app/api portal + the shared /webhooks-free surface.
// Mirrors api.ts conventions but dispatches a PORTAL unauthorized event so a
// dead user session bounces to /app/login, never into the admin console.

export interface PortalUser {
  id: string;
  email: string;
  balance_usd: number;
  enabled: boolean;
  created_at: number;
}

export interface MeResponse {
  user: PortalUser;
  billing_configured: boolean;
}

export interface PortalKey {
  id: string;
  name: string;
  key_prefix: string;
  /** M10: admin-set per-key rate limit (req/min) — read-only in the portal. */
  rate_limit_rpm: number | null;
  allowed_models: string[];
  enabled: boolean;
  last_used_at: number | null;
  created_at: number;
  spent_usd: number;
  request_count: number;
  /** Only present on the create response — the raw key is never stored. */
  key?: string;
}

export interface PortalUsageRow {
  id: string;
  model_slug: string;
  dialect: 'chat' | 'responses' | 'messages';
  status: number;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  created_at: number;
}

export interface BalanceEntry {
  id: string;
  kind: 'topup' | 'usage' | 'adjustment';
  delta_usd: number;
  note: string | null;
  created_at: number;
}

export interface BillingInfo {
  balance_usd: number;
  configured: boolean;
  entries: BalanceEntry[];
}

// -------------------------------------------------------------- orgs (M9)

export type OrgRole = 'owner' | 'member';

export interface OrgMember {
  user_id: string;
  email: string | null;
  role: OrgRole;
  joined_at: number;
}

export interface PortalOrg {
  id: string;
  name: string;
  role: OrgRole;
  balance_usd: number;
  enabled: boolean;
  member_count?: number;
  created_at: number;
  /** Owner-only secret — absent on member/non-member responses. */
  join_code?: string;
  members?: OrgMember[];
}

/** Org-scoped key — same shape as a personal key plus creator attribution. */
export interface OrgKey extends PortalKey {
  created_by: string | null;
  created_by_email: string | null;
}

export interface OrgUsageRow extends PortalUsageRow {
  key_id: string | null;
  user_id: string | null;
}

export class PortalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (res.status === 401 && !url.includes('/login') && !url.includes('/signup')) {
    window.dispatchEvent(new CustomEvent('khateway:portal-unauthorized'));
    throw new PortalError('Session expired — sign in again.', 401);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON body — handled below
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `Request failed (HTTP ${res.status})`;
    throw new PortalError(msg, res.status);
  }
  return data as T;
}

export const portalApi = {
  signup: (email: string, password: string) =>
    req<{ user: PortalUser }>('/app/api/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    req<{ user: PortalUser }>('/app/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req<{ ok: boolean }>('/app/api/logout', { method: 'POST' }),
  me: () => req<MeResponse>('/app/api/me'),

  keys: () => req<PortalKey[]>('/app/api/keys'),
  createKey: (k: Record<string, unknown>) => req<PortalKey>('/app/api/keys', { method: 'POST', body: JSON.stringify(k) }),
  updateKey: (id: string, k: Record<string, unknown>) => req<PortalKey>(`/app/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify(k) }),
  deleteKey: (id: string) => req<{ ok: boolean }>(`/app/api/keys/${id}`, { method: 'DELETE' }),

  usage: (limit = 50) => req<PortalUsageRow[]>(`/app/api/usage?limit=${limit}`),
  billing: () => req<BillingInfo>('/app/api/billing'),
  createCheckout: (amountUsd: number) =>
    req<{ url: string }>('/app/api/billing/checkout', { method: 'POST', body: JSON.stringify({ amount_usd: amountUsd }) }),

  orgs: () => req<PortalOrg[]>('/app/api/orgs'),
  createOrg: (name: string) => req<PortalOrg>('/app/api/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  joinOrg: (code: string) => req<PortalOrg>('/app/api/orgs/join', { method: 'POST', body: JSON.stringify({ code }) }),
  org: (id: string) => req<PortalOrg>(`/app/api/orgs/${id}`),
  deleteOrg: (id: string) => req<{ ok: boolean }>(`/app/api/orgs/${id}`, { method: 'DELETE' }),
  regenerateCode: (id: string) => req<{ join_code: string }>(`/app/api/orgs/${id}/regenerate-code`, { method: 'POST' }),
  leaveOrg: (id: string) => req<{ ok: boolean }>(`/app/api/orgs/${id}/leave`, { method: 'POST' }),
  setMemberRole: (id: string, userId: string, role: OrgRole) =>
    req<OrgMember>(`/app/api/orgs/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (id: string, userId: string) =>
    req<{ ok: boolean }>(`/app/api/orgs/${id}/members/${userId}`, { method: 'DELETE' }),

  orgKeys: (id: string) => req<OrgKey[]>(`/app/api/orgs/${id}/keys`),
  createOrgKey: (id: string, k: Record<string, unknown>) =>
    req<OrgKey>(`/app/api/orgs/${id}/keys`, { method: 'POST', body: JSON.stringify(k) }),
  updateOrgKey: (id: string, keyId: string, k: Record<string, unknown>) =>
    req<OrgKey>(`/app/api/orgs/${id}/keys/${keyId}`, { method: 'PATCH', body: JSON.stringify(k) }),
  deleteOrgKey: (id: string, keyId: string) => req<{ ok: boolean }>(`/app/api/orgs/${id}/keys/${keyId}`, { method: 'DELETE' }),

  orgUsage: (id: string, limit = 50) => req<OrgUsageRow[]>(`/app/api/orgs/${id}/usage?limit=${limit}`),
  orgBilling: (id: string) => req<BillingInfo>(`/app/api/orgs/${id}/billing`),
  orgCheckout: (id: string, amountUsd: number) =>
    req<{ url: string }>(`/app/api/orgs/${id}/billing/checkout`, { method: 'POST', body: JSON.stringify({ amount_usd: amountUsd }) }),
};
