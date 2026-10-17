// Golden-fixture suite config. Tests are plain Node (Node ≥20 ships the
// Workers globals the worker modules rely on: fetch/Response/ReadableStream/
// crypto.subtle/TextEncoder/btoa), so no environment plugins are needed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
