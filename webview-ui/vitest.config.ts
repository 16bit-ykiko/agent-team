import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Required for @testing-library/react's automatic DOM cleanup between tests.
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
