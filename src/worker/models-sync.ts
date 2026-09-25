// Free-models auto-sync: keeps the Khateway catalog fresh with FREE upstream
// models. Runs daily via the Worker cron trigger (03:17 UTC) and on demand via
// POST /api/admin/models/sync. Per-provider opt-in (providers.auto_sync).
//
// Free detection (verified data beats naming):
//   - gemini adapter  → every generateContent entry counts as free (Google's
//     $0 tier; the listing carries no pricing at all);
//   - pricing present → free iff BOTH per-1M prices are exactly 0 (OpenRouter
//     `pricing.prompt`/`pricing.completion` "0"/"0", captured by discovery.ts);
//   - no pricing      → free iff the id ends with `:free`.
// Sync-created rows carry models.sync_source='free_sync' with pricing 0/0 —
// genuine zeros, so cost math bills $0.00 (null pricing means UNKNOWN, not
// free; the sync never writes null).
//
// Ownership rule: the sync owns ONLY its own rows. Rows it created get
// metadata refreshes (display name / context window / output cap — non-null
// upstream values only) and enabled-state management: dropouts (no longer in
// the upstream free set) are auto-disabled, reappearances re-enabled.
// Admin-created rows are never modified — a slug collision is reported as a
// skip. Nothing is ever deleted. To permanently exclude one sync-owned model,
// turn the provider's auto-sync off first (deleting it just gets recreated on
// the next run while the upstream still offers it).
import { and, eq } from 'drizzle-orm';
import type { Adapter, Env } from './env';
import { parseAdapters, SLUG_RE } from './routing';
import { getDb } from './db';
import { models, providers } from './db/schema';
import { setModelsSyncLastRun } from './db/settings';
import { listUpstreamModelsForAdapter } from './discovery';
import type { ProviderRow, UpstreamModel } from './discovery';

type ModelInsert = typeof models.$inferInsert;

/** models.sync_source marker for rows created (and thus owned) by this sync. */
export const SYNC_SOURCE_FREE = 'free_sync';
/** Safety cap per provider per run: free pools churn; we don't want one
 * aggregator listing hundreds of zeros to flood the catalog. */
export const SYNC_MAX_MODELS_PER_PROVIDER = 200;

/**
 * Derives a platform slug from an upstream id. Free-pool ids are usually
 * OpenRouter-shaped (`vendor/model:free`) — `/` and `:` are banned by the slug
 * alphabet, so runs of banned chars collapse to a single '-' (edges trimmed).
 * Returns null when nothing usable remains (the entry is skipped). The RAW id
 * always rides the row's upstream_model, so the gateway still sends the
 * upstream exactly what it listed.
 */
export function syncSlugForId(id: string): string | null {
  const slug = id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return SLUG_RE.test(slug) ? slug : null;
}

// ---------------------------------------------------------------- pure logic

/** Is this discovered upstream model free? See module comment for the rules. */
export function isFreeUpstreamModel(m: UpstreamModel, adapter: Adapter): boolean {
  if (adapter === 'gemini') return true;
  if (m.pricingInput != null && m.pricingOutput != null) {
    return m.pricingInput === 0 && m.pricingOutput === 0;
  }
  return m.id.endsWith(':free');
}

/**
 * Merges per-adapter listings into the provider's deduped free-entry list.
 * Dedupe is on the DERIVED slug (OpenRouter-shaped ids collapse), first entry
 * wins — adapter declaration order is the provider's preference, same as the
 * gateway adapter pick order.
 */
export function selectSyncEntries(listings: { adapter: Adapter; models: UpstreamModel[] }[]): UpstreamModel[] {
  const seen = new Set<string>();
  const out: UpstreamModel[] = [];
  for (const { adapter, models: listing } of listings) {
    for (const m of listing) {
      if (!isFreeUpstreamModel(m, adapter)) continue;
      const slug = syncSlugForId(m.id);
      const key = slug ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/** The slice of the models table the planner needs (subset of a full row). */
export interface SyncExistingModel {
  id: string;
  providerId: string;
  slug: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  syncSource: string | null;
}

export interface SyncPlan {
  /** New rows to create (pricing always 0/0, sync-owned, enabled). `slug` is
   * derived from the upstream id; `upstreamModel` keeps the RAW id so the
   * gateway sends upstream exactly what it listed. */
  creates: { slug: string; upstreamModel: string; displayName: string | null; contextWindow: number | null; maxOutputTokens: number | null }[];
  /** Metadata refreshes for sync-owned rows — only the fields that change. */
  updates: { id: string; slug: string; displayName?: string; contextWindow?: number; maxOutputTokens?: number }[];
  /** Sync-owned rows reappearing in the free set while disabled. */
  enables: { id: string; slug: string }[];
  /** Sync-owned rows that dropped out of the free set while enabled. */
  disables: { id: string; slug: string }[];
  skips: { id: string; reason: string }[];
}

/**
 * Diffs the free entries against the current catalog (ALL models, any
 * provider — slugs are globally unique) into an executable plan. Pure: no DB
 * access, golden-tested. Cross-provider slug conflicts and manually managed
 * models (sync_source null) are skipped, never touched.
 */
export function planSyncUpserts(providerId: string, entries: UpstreamModel[], existing: SyncExistingModel[]): SyncPlan {
  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  const ownSyncRows = existing.filter((r) => r.providerId === providerId && r.syncSource === SYNC_SOURCE_FREE);
  const plan: SyncPlan = { creates: [], updates: [], enables: [], disables: [], skips: [] };
  const entrySlugs = new Set<string>();

  for (const e of entries) {
    const slug = syncSlugForId(e.id);
    if (!slug) {
      plan.skips.push({ id: e.id, reason: 'id cannot be mapped to a valid slug (letters, digits, dots, dashes, underscores)' });
      continue;
    }
    entrySlugs.add(slug);
    const row = bySlug.get(slug);
    if (row && row.providerId !== providerId) {
      plan.skips.push({ id: e.id, reason: 'slug already in use by another provider' });
      continue;
    }
    if (row && row.syncSource !== SYNC_SOURCE_FREE) {
      plan.skips.push({ id: e.id, reason: 'slug already in use (manually managed model)' });
      continue;
    }
    if (row) {
      const patch: SyncPlan['updates'][number] = { id: row.id, slug: row.slug };
      let changed = false;
      if (e.displayName != null && e.displayName !== row.displayName) {
        patch.displayName = e.displayName.slice(0, 200);
        changed = true;
      }
      if (e.contextWindow != null && e.contextWindow !== row.contextWindow) {
        patch.contextWindow = e.contextWindow;
        changed = true;
      }
      if (e.maxOutputTokens != null && e.maxOutputTokens !== row.maxOutputTokens) {
        patch.maxOutputTokens = e.maxOutputTokens;
        changed = true;
      }
      if (changed) plan.updates.push(patch);
      if (!row.enabled) plan.enables.push({ id: row.id, slug: row.slug });
      continue;
    }
    plan.creates.push({ slug, upstreamModel: e.id, displayName: e.displayName, contextWindow: e.contextWindow, maxOutputTokens: e.maxOutputTokens });
  }

  for (const row of ownSyncRows) {
    if (!entrySlugs.has(row.slug) && row.enabled) plan.disables.push({ id: row.id, slug: row.slug });
  }
  return plan;
}

// ----------------------------------------------------------------- executor

export interface ModelsSyncProviderResult {
  provider_id: string;
  provider_name: string;
  ok: boolean;
  error: string | null;
  /** Per-adapter probe failures when at least one OTHER adapter answered. */
  adapter_errors: string[];
  created: string[];
  updated: string[];
  disabled: string[];
  enabled: string[];
  skipped: { id: string; reason: string }[];
}

export interface ModelsSyncSummary {
  ran_at: number;
  triggered_by: 'cron' | 'admin';
  providers_synced: number;
  providers_failed: number;
  totals: { created: number; updated: number; disabled: number; enabled: number; skipped: number };
  results: ModelsSyncProviderResult[];
}

async function syncProvider(env: Env, p: ProviderRow, existing: SyncExistingModel[]): Promise<ModelsSyncProviderResult> {
  const base: ModelsSyncProviderResult = {
    provider_id: p.id,
    provider_name: p.name,
    ok: false,
    error: null,
    adapter_errors: [],
    created: [],
    updated: [],
    disabled: [],
    enabled: [],
    skipped: [],
  };

  const declared = parseAdapters(p.adapters);
  const adapters: Adapter[] = declared.length ? declared : ['openai'];
  const listings: { adapter: Adapter; models: UpstreamModel[] }[] = [];
  for (const adapter of adapters) {
    const res = await listUpstreamModelsForAdapter(env, p, adapter);
    if (res.ok) listings.push({ adapter, models: res.models });
    else base.adapter_errors.push(`${adapter}: ${res.error}`);
  }
  if (!listings.length) {
    return { ...base, error: base.adapter_errors.join('; ') || 'no usable adapters' };
  }

  const all = selectSyncEntries(listings);
  const skipped = all
    .slice(SYNC_MAX_MODELS_PER_PROVIDER)
    .map((m) => ({ id: m.id, reason: `free-model sync cap (${SYNC_MAX_MODELS_PER_PROVIDER}) reached` }));
  const entries = all.slice(0, SYNC_MAX_MODELS_PER_PROVIDER);

  const plan = planSyncUpserts(p.id, entries, existing);
  const db = getDb(env);
  const now = Date.now();

  for (const c of plan.creates) {
    const val: ModelInsert = {
      id: crypto.randomUUID(),
      providerId: p.id,
      slug: c.slug,
      upstreamModel: c.upstreamModel,
      displayName: c.displayName,
      contextWindow: c.contextWindow,
      maxOutputTokens: c.maxOutputTokens,
      // Verified-free rows bill $0.00 (genuine zeros — null would mean unknown).
      pricingInput: 0,
      pricingOutput: 0,
      enabled: true,
      syncSource: SYNC_SOURCE_FREE,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(models).values(val);
  }
  for (const u of plan.updates) {
    const patch: Partial<ModelInsert> = { updatedAt: now };
    if (u.displayName !== undefined) patch.displayName = u.displayName;
    if (u.contextWindow !== undefined) patch.contextWindow = u.contextWindow;
    if (u.maxOutputTokens !== undefined) patch.maxOutputTokens = u.maxOutputTokens;
    await db.update(models).set(patch).where(eq(models.id, u.id));
  }
  for (const e of plan.enables) {
    await db.update(models).set({ enabled: true, updatedAt: now }).where(eq(models.id, e.id));
  }
  for (const d of plan.disables) {
    await db.update(models).set({ enabled: false, updatedAt: now }).where(eq(models.id, d.id));
  }

  return {
    ...base,
    ok: true,
    created: plan.creates.map((c) => c.slug),
    updated: plan.updates.map((u) => u.slug),
    disabled: plan.disables.map((d) => d.slug),
    enabled: plan.enables.map((e) => e.slug),
    skipped: [...plan.skips, ...skipped],
  };
}

/**
 * Runs the free-models sync against every enabled provider with auto_sync on,
 * then persists the summary to settings (models_sync_last_run) for the admin
 * Models page. One provider's failure never stops the others; the summary
 * carries per-provider results either way.
 */
export async function runModelsSync(env: Env, triggeredBy: 'cron' | 'admin' = 'cron'): Promise<ModelsSyncSummary> {
  const db = getDb(env);
  const optedIn = await db
    .select()
    .from(providers)
    .where(and(eq(providers.autoSync, true), eq(providers.enabled, true)));
  const existing = await db
    .select({
      id: models.id,
      providerId: models.providerId,
      slug: models.slug,
      displayName: models.displayName,
      contextWindow: models.contextWindow,
      maxOutputTokens: models.maxOutputTokens,
      enabled: models.enabled,
      syncSource: models.syncSource,
    })
    .from(models);

  const results: ModelsSyncProviderResult[] = [];
  for (const p of optedIn) {
    try {
      const result = await syncProvider(env, p, existing);
      results.push(result);
      // Fold this provider's creates into the snapshot so a LATER provider
      // sees them as cross-provider slug conflicts, not create-races.
      for (const c of result.created) {
        existing.push({
          id: `synced:${p.id}:${c}`,
          providerId: p.id,
          slug: c,
          displayName: null,
          contextWindow: null,
          maxOutputTokens: null,
          enabled: true,
          syncSource: SYNC_SOURCE_FREE,
        });
      }
    } catch (e) {
      results.push({
        provider_id: p.id,
        provider_name: p.name,
        ok: false,
        error: e instanceof Error ? e.message : 'sync failed',
        adapter_errors: [],
        created: [],
        updated: [],
        disabled: [],
        enabled: [],
        skipped: [],
      });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      created: acc.created + r.created.length,
      updated: acc.updated + r.updated.length,
      disabled: acc.disabled + r.disabled.length,
      enabled: acc.enabled + r.enabled.length,
      skipped: acc.skipped + r.skipped.length,
    }),
    { created: 0, updated: 0, disabled: 0, enabled: 0, skipped: 0 },
  );
  const summary: ModelsSyncSummary = {
    ran_at: Date.now(),
    triggered_by: triggeredBy,
    providers_synced: results.filter((r) => r.ok).length,
    providers_failed: results.filter((r) => !r.ok).length,
    totals,
    results,
  };
  try {
    await setModelsSyncLastRun(env, summary);
  } catch (e) {
    // The sync itself succeeded; only the summary write failed. Surface it in
    // logs — the run's DB writes stand and the next run overwrites nothing.
    console.error('[khateway] models sync: failed to persist summary', e);
  }
  return summary;
}
