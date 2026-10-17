// Seeds Khateway with providers that offer FREE models, opting each into the
// free-models auto-sync (daily 03:17 UTC cron / "Sync now" button), then runs
// the sync once so the catalog fills immediately.
//
// Idempotent: providers are matched by name — existing rows are PATCHed back
// in line (auto_sync / free_tier / key when an env var provides one) instead
// of duplicated. Models are never touched here; the sync owns them.
//
// Usage:
//   npm run seed:free                                  # local dev :8787
//   npm run seed:free -- --base https://khateway.chengsokdara.workers.dev \
//                       --password '<admin password>'
// Flags:
//   --base <url>      gateway origin (default http://127.0.0.1:8787)
//   --password <str>  admin password (fallback ADMIN_PASSWORD env, then the
//                     local dev default 'khateway-admin')
//   --only a,b        restrict to catalog names (case-insensitive substrings)
//   --no-sync         seed providers but skip the immediate sync run
//
// API keys are OPTIONAL and read from the environment when present — a
// provider created keyless still syncs as soon as a key is PATCHed later
// (admin UI, or simply re-run this script with the env var set):
//   OPENROUTER_API_KEY  optional — OpenRouter's /models listing is public, the
//                       key is only needed to CALL the free models
//   GEMINI_API_KEY      Google AI Studio key (free tier)
//   GITHUB_TOKEN        GitHub PAT with `models` scope (GitHub Models)
//   GROQ_API_KEY  CEREBRAS_API_KEY  MISTRAL_API_KEY  SAMBANOVA_API_KEY  NVIDIA_API_KEY
//   POLLINATIONS_TOKEN  optional tier token (anonymous works, rate-limited ~1 req/15s)

// The researched catalog. `free_tier: true` = the WHOLE API is a $0
// (rate-limited) tier and the listing carries no pricing — the sync imports
// the entire listing as free. OpenRouter keeps it false: its listing carries
// real per-token pricing, so the sync imports only the verified $0 entries.
// Gemini (native) needs no flag — the gemini adapter rule already counts its
// listing as free-tier.
const CATALOG = [
  {
    name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    adapters: ['openai', 'anthropic'],
    free_tier: false,
    keyEnv: 'OPENROUTER_API_KEY',
    note: 'free models are the :free / $0-priced entries (~50 req/day; 1000/day with $10 credits)',
  },
  {
    name: 'Gemini (AI Studio)',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    adapters: ['gemini'],
    free_tier: false,
    keyEnv: 'GEMINI_API_KEY',
    note: 'Google AI Studio free tier — needs a key before the sync can list models',
  },
  {
    name: 'Pollinations',
    base_url: 'https://text.pollinations.ai/openai',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'POLLINATIONS_TOKEN',
    note: 'fully keyless; anonymous tier is rate-limited (~1 request / 15 s)',
  },
  {
    name: 'GitHub Models',
    base_url: 'https://models.github.ai/inference',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'GITHUB_TOKEN',
    note: 'free with any GitHub account — PAT with the `models` scope',
  },
  {
    name: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'GROQ_API_KEY',
    note: 'free tier with per-model RPM/RPD caps',
  },
  {
    name: 'Cerebras',
    base_url: 'https://api.cerebras.ai/v1',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'CEREBRAS_API_KEY',
    note: 'free tier with daily token caps',
  },
  {
    name: 'Mistral',
    base_url: 'https://api.mistral.ai/v1',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'MISTRAL_API_KEY',
    note: 'La Plateforme free tier (~1B tokens/month, open-weight models; phone verification)',
  },
  {
    name: 'SambaNova',
    base_url: 'https://api.sambanova.ai/v1',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'SAMBANOVA_API_KEY',
    note: 'permanent free tier',
  },
  {
    name: 'NVIDIA NIM',
    base_url: 'https://integrate.api.nvidia.com/v1',
    adapters: ['openai'],
    free_tier: true,
    keyEnv: 'NVIDIA_API_KEY',
    note: 'free signup credits',
  },
];

// ------------------------------------------------------------------ cli args

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const base = (flag('base') || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const password = flag('password') || process.env.ADMIN_PASSWORD || 'khateway-admin';
const only = flag('only') ? flag('only').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
const wantSync = !args.includes('--no-sync');

const selected = only
  ? CATALOG.filter((p) => only.some((q) => p.name.toLowerCase().includes(q)))
  : CATALOG;
if (!selected.length) {
  console.error(`No catalog entry matches --only "${flag('only')}". Known: ${CATALOG.map((p) => p.name).join(', ')}`);
  process.exit(1);
}

// ------------------------------------------------------------------ api client

let cookie = '';
const j = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const sc = res.headers.get('set-cookie');
  if (sc && sc.includes('khateway_session=') && !sc.includes('Max-Age=0')) cookie = sc.split(';')[0];
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body };
};

(async () => {
  console.log(`khateway free-providers seed → ${base}`);
  const health = await j('/health');
  if (health.status !== 200) {
    console.error(`server not reachable at ${base} (GET /health → ${health.status}). Start it with \`npm run dev\` or check --base.`);
    process.exit(1);
  }
  const login = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
  if (login.status !== 200) {
    console.error(`admin login failed (${login.status}) — wrong --password / ADMIN_PASSWORD?`);
    process.exit(1);
  }

  const existing = (await j('/api/admin/providers')).body ?? [];
  const byName = new Map(existing.map((p) => [p.name, p]));

  for (const cat of selected) {
    const apiKey = (process.env[cat.keyEnv] || '').trim();
    const row = byName.get(cat.name);
    if (!row) {
      const created = await j('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: cat.name,
          adapters: cat.adapters,
          base_url: cat.base_url,
          auto_sync: true,
          free_tier: cat.free_tier,
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      });
      if (created.status !== 201) {
        console.error(`✗ ${cat.name}: create failed (${created.status}) ${JSON.stringify(created.body)}`);
        continue;
      }
      console.log(`+ ${cat.name} created (auto_sync on${cat.free_tier ? ', free_tier on' : ''}${apiKey ? ', key set' : ', keyless'}) — ${cat.note}`);
    } else {
      // Re-align an existing row: auto_sync/free_tier always, key only when an
      // env var provides one AND the row has none yet (never clobber a stored
      // key with an empty one — PATCH api_key:'' would clear it).
      const patch = {};
      if (row.auto_sync !== true) patch.auto_sync = true;
      if ((row.free_tier ?? false) !== cat.free_tier) patch.free_tier = cat.free_tier;
      if (apiKey && !row.key_hint) patch.api_key = apiKey;
      if (Object.keys(patch).length) {
        const patched = await j(`/api/admin/providers/${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        if (patched.status !== 200) {
          console.error(`✗ ${cat.name}: patch failed (${patched.status}) ${JSON.stringify(patched.body)}`);
          continue;
        }
        console.log(`~ ${cat.name} updated (${Object.keys(patch).join(', ')})`);
      } else {
        console.log(`= ${cat.name} already in line`);
      }
      if (!row.key_hint && !apiKey) console.log(`  (no key yet — sync will fail for it until one is set: ${cat.keyEnv})`);
    }
  }

  if (!wantSync) {
    console.log('skipping sync (--no-sync)');
    return;
  }

  console.log('\nrunning free-models sync…');
  const sync = await j('/api/admin/models/sync', { method: 'POST' });
  if (sync.status !== 200) {
    console.error(`sync failed (${sync.status}) ${JSON.stringify(sync.body)}`);
    process.exit(1);
  }
  const t = sync.body.totals ?? {};
  console.log(
    `sync done: ${sync.body.providers_synced}/${sync.body.providers_synced + sync.body.providers_failed} providers ok — ` +
      `created ${t.created}, updated ${t.updated}, disabled ${t.disabled}, skipped ${t.skipped}`,
  );
  for (const r of sync.body.results ?? []) {
    if (r.ok) {
      console.log(`  ✓ ${r.provider_name}: +${r.created.length} created, ${r.updated.length} updated${r.adapter_errors.length ? ` (adapter notes: ${r.adapter_errors.join('; ')})` : ''}`);
    } else {
      const missingKey = /401|403|unauthor|api key/i.test(r.error ?? '');
      console.log(`  ✗ ${r.provider_name}: ${r.error ?? 'failed'}${missingKey ? ' — set its API key and re-run' : ''}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
