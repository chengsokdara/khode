import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Admin SPA. Built into ../web-dist which wrangler serves as static assets
// (see wrangler.jsonc). `npm run dev:ui` proxies the worker API prefixes to
// `wrangler dev` on :8787 for hot-reload UI development (/app pages stay
// client-side in vite; only /app/api is a worker route).
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
      '/admin': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/app/api': 'http://127.0.0.1:8787',
      '/webhooks': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
});
