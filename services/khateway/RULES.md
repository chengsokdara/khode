# RULES.md — Non-negotiable rules for AI agents working on Khateway

(Mirrors racode workspace RULES.md; itself adapted from termagent's rules.)

1. **Docs sync & interruption safety (mandatory).** While working, keep
   `STATUS.md` current (what's done, what's in flight, how to resume) — an
   interrupted session must be able to pick up from it. Before declaring a task
   done, update:
   - `STATUS.md` — build/feature state, date, what changed in this task.
   - `MEMORY.md` — durable facts: decisions, user preferences, rough edges, scope changes.
   - `AGENTS.md` — only if architecture, file map, build commands, or conventions changed.
   A task is **not complete** if these files are stale.
2. **Stack & dependencies are frozen.** No adding/removing/upgrading npm
   packages, no swapping Hono/Drizzle/Vite/React/Tailwind, no runtime changes
   without explicit user approval. The stack in AGENTS.md is deliberate
   (includes: no routing library, no UI kit library).
3. **No unasked rewrites.** Edit existing code in place. Never rewrite working
   modules or restructure files beyond the literal request — mention adjacent
   improvements as suggestions instead of doing them.
4. **Backward-compatible data.** Schema changes only as NEW drizzle migrations
   (never edit an applied migration file; don't rename/drop live columns).
   Admin JSON API: additive fields, never silently rename/remove existing
   fields. Existing provider/model/session rows must survive deploys.
5. **Secrets hygiene.** Provider/client keys and all secrets live only in
   `.dev.vars` (dev) or `wrangler secret` (remote). Never print, log, echo, or
   commit them; redact in docs, examples, and smoke output. Request logs (M7)
   must redact `Authorization`/`x-api-key` headers and truncate bodies.
6. **Styling only via Tailwind classes + shared tokens.** No inline styles or
   scattered raw hex values; colors/palette come from `src/web/index.css` and
   the tokens in `components/ui.tsx` (zinc neutrals + emerald accent).
7. **Module boundaries.** Dialect/wire-format logic only in the gateway +
   `dialects/`/`adapters/` modules (once M3 exists); crypto only in
   `crypto.ts`; session logic only in `auth.ts`; DB access via `db/`. Admin API
   always answers JSON `{ error }` on failure.
8. **Respect the user's language** in responses; keep code identifiers/comments
   in English.
9. **No destructive commands** (git push/reset, `wrangler deploy`, remote D1
   migrations, deleting data outside the task scope) without explicit user request.
10. **Keep MEMORY.md honest.** Record mistakes and caveats, not just wins —
    future sessions (and other AI models) rely on it.
