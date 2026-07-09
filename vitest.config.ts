import { defineConfig } from "vitest/config";

// Server-side tests; webview-ui has its own vitest setup (jsdom).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
