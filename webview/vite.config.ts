import * as fs from "fs";
import * as path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = "../dist/webview";

export default defineConfig({
  plugins: [
    react(),
    (() => {
      let resolvedOutDir = "";
      return {
        // public/replay.jsonl is a local capture for `npm run dev -- ?replay`
        // (real session transcripts); it must never reach the served bundle.
        name: "drop-replay-log",
        apply: "build" as const,
        configResolved(config: { root: string; build: { outDir: string } }) {
          resolvedOutDir = path.resolve(config.root, config.build.outDir);
        },
        closeBundle() {
          fs.rmSync(path.join(resolvedOutDir, "replay.jsonl"), { force: true });
        },
      };
    })(),
  ],
  base: "./",
  build: {
    outDir,
    emptyOutDir: true,
  },
});
