import { defineConfig } from "vitest/config";

// Server-side tests only; webview-ui has its own vitest setup (jsdom).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
