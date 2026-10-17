import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Admin/portal SPA. Built into ../web-dist which wrangler serves as static
// assets (see wrangler.jsonc): landing at /, admin pages at /admin, portal
// pages at /app — all client-side routes, hot-reloaded by vite in dev. Only
// the API prefixes below proxy to `wrangler dev` on :8787.
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../web-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // ^/api/ = regex: must NOT match /api.ts etc. — root is src/web, so the
      // app's own modules live at top-level URLs (App.tsx imports './api').
      '^/api/': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/webhooks': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
});
