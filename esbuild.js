const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/server/index.ts"],
    outfile: "dist/server.js",
  },
];

if (watch) {
  Promise.all(builds.map((b) => esbuild.context(b).then((ctx) => ctx.watch()))).then(() =>
    console.log("Watching for changes..."),
  );
} else {
  Promise.all(builds.map((b) => esbuild.build(b))).then(() =>
    console.log("Extension + server built."),
  );
}
