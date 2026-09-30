import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const build = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  // The search index runs in a worker thread of its own (history-service.ts).
  entryPoints: {
    server: "src/index.ts",
    "history-worker": "src/workspace/history-worker.ts",
  },
  outdir: "../dist",
  external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],
};

if (watch) {
  esbuild.context(build).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  });
} else {
  esbuild.build(build).then(() => console.log("Server built."));
}
