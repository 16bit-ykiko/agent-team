// Cuts Sarasa Mono SC (be5invis/Sarasa-Gothic, its SarasaMonoSC TTF release)
// into slices by character, as Google Fonts serves Chinese: a page loads
// only the slices of the characters it shows. Regular, bold and their
// italics, all four real faces, so no browser fakes one from another (Sarasa
// slants its Chinese as well).
//
//   npm run sarasa-font -- <dir with SarasaMonoSC-{Regular,Bold,Italic,BoldItalic}.ttf>
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const [src] = process.argv.slice(2);
if (!src) throw new Error("usage: npm run sarasa-font -- <dir with the SarasaMonoSC TTFs>");
const out = path.resolve(import.meta.dirname, "..", "webview", "src", "fonts", "sarasa-mono-sc");

// A copy installed on the machine is used instead, by its full or PostScript
// name: the family name alone would match the regular for every weight.
const FACES = [
  { dir: "regular", file: "Regular", weight: 400, style: "normal", full: "", ps: "Regular" },
  { dir: "bold", file: "Bold", weight: 700, style: "normal", full: " Bold", ps: "Bold" },
  { dir: "italic", file: "Italic", weight: 400, style: "italic", full: " Italic", ps: "Italic" },
  {
    dir: "bold-italic",
    file: "BoldItalic",
    weight: 700,
    style: "italic",
    full: " Bold Italic",
    ps: "Bold-Italic",
  },
];

// The splitter is needed once per font release: installed aside, not a
// dependency of the project.
const tool = fs.mkdtempSync(path.join(os.tmpdir(), "cn-font-split-"));
execFileSync("npm", ["install", "--prefix", tool, "--no-save", "cn-font-split@7.4.3"], {
  stdio: "inherit",
});
const { fontSplit } = (await import(
  pathToFileURL(path.join(tool, "node_modules", "cn-font-split", "dist", "node", "index.mjs")).href
)) as { fontSplit: (config: Record<string, unknown>) => Promise<void> };

fs.rmSync(out, { recursive: true, force: true });
for (const w of FACES) {
  const dir = path.join(out, w.dir);
  await fontSplit({
    input: path.join(src, `SarasaMonoSC-${w.file}.ttf`),
    outDir: dir,
    css: {
      fontFamily: "Sarasa Mono SC",
      fontWeight: String(w.weight),
      fontStyle: w.style,
      fontDisplay: "swap",
      commentUnicodes: false,
      commentNameTable: false,
    },
    testHtml: false,
    reporter: false,
  });
  fs.rmSync(path.join(dir, "index.proto"), { force: true });
  const css = path.join(dir, "result.css");
  const local = [`Sarasa Mono SC${w.full}`, `Sarasa-Mono-SC-${w.ps}`]
    .map((n) => `local("${n}")`)
    .join(",");
  fs.writeFileSync(css, fs.readFileSync(css, "utf8").replaceAll('local("Sarasa Mono SC")', local));
}

const license = await fetch(
  "https://raw.githubusercontent.com/be5invis/Sarasa-Gothic/main/LICENSE",
);
if (!license.ok) throw new Error(`license: HTTP ${license.status}`);
fs.writeFileSync(path.join(out, "LICENSE"), await license.text());
fs.rmSync(tool, { recursive: true, force: true });
// The splitter's native library keeps the process alive once it is done.
process.exit(0);
