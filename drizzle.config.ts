import { defineConfig } from 'drizzle-kit';

// D1-compatible SQLite schema. Migrations land in ./drizzle and are applied
// with `npm run migrate:local` (or `wrangler d1 migrations apply khateway --remote`).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/worker/db/schema.ts',
  out: './drizzle',
});
