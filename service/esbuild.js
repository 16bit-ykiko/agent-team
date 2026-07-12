const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const build = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
  entryPoints: ["src/index.ts"],
  outfile: "../dist/server.js",
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
