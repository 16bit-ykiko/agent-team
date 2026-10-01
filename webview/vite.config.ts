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
  // The KaTeX stylesheet and the renderer rehype-katex bundles must be one
  // version: npm installs a copy per dependent.
  resolve: { dedupe: ["katex"] },
  build: {
    outDir,
    emptyOutDir: true,
    // Inlined, the font's small slices would load with the stylesheet
    // whether a page shows their characters or not.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
});
