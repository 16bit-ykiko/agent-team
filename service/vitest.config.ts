import { defineConfig } from "vitest/config";

// Service tests; webview has its own vitest setup (jsdom).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Wake-up times render as local clock times in the snap transcripts.
    env: { TZ: "UTC" },
  },
});
