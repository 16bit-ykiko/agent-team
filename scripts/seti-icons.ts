// Takes VS Code's default file icons (the Seti theme) from a VS Code
// install: the font, its license, and which icon a file gets, as VS Code
// picks it — by file name, by extension (the longest first), by the
// language VS Code gives the file, else the default.
//
//   npm run seti-icons -- <vscode>/resources/app
import * as fs from "fs";
import * as path from "path";

const app = process.argv[2];
if (!app) throw new Error("usage: npm run seti-icons -- <vscode>/resources/app");
const theme = path.join(app, "extensions", "theme-seti");
const out = path.resolve(import.meta.dirname, "..", "webview", "src", "panels", "seti");

interface Definition {
  fontCharacter: string;
  fontColor?: string;
}
interface IconTheme {
  iconDefinitions: Record<string, Definition>;
  file: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}
interface Language {
  id: string;
  extensions?: string[];
  filenames?: string[];
}

const seti = JSON.parse(
  fs.readFileSync(path.join(theme, "icons", "vs-seti-icon-theme.json"), "utf-8"),
) as IconTheme;

// Each icon once: its character and colour.
const icons: Array<[string, string]> = [];
const indexOf = new Map<string, number>();
const icon = (id: string): number => {
  let i = indexOf.get(id);
  if (i === undefined) {
    const d = seti.iconDefinitions[id];
    const char = String.fromCodePoint(parseInt(d.fontCharacter.replace(/^\\/, ""), 16));
    i = icons.push([char, d.fontColor ?? "#d4d7d6"]) - 1;
    indexOf.set(id, i);
  }
  return i;
};

const names: Record<string, number> = {};
const exts: Record<string, number> = {};
// Languages first, the theme's own names and extensions over them.
for (const dir of fs.readdirSync(path.join(app, "extensions"))) {
  const manifest = path.join(app, "extensions", dir, "package.json");
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
    contributes?: { languages?: Language[] };
  };
  for (const lang of pkg.contributes?.languages ?? []) {
    const id = seti.languageIds[lang.id];
    if (!id) continue;
    for (const e of lang.extensions ?? []) exts[e.replace(/^\./, "").toLowerCase()] ??= icon(id);
    for (const n of lang.filenames ?? []) names[n.toLowerCase()] ??= icon(id);
  }
}
for (const [e, id] of Object.entries(seti.fileExtensions)) exts[e.toLowerCase()] = icon(id);
for (const [n, id] of Object.entries(seti.fileNames)) names[n.toLowerCase()] = icon(id);

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(theme, "icons", "seti.woff"), path.join(out, "seti.woff"));
fs.copyFileSync(path.join(theme, "ThirdPartyNotices.txt"), path.join(out, "LICENSE.txt"));
fs.writeFileSync(
  path.join(out, "icons.json"),
  `${JSON.stringify({ file: icon(seti.file), icons, names, exts })}\n`,
);
console.log(
  `${icons.length} icons, ${Object.keys(names).length} names, ${Object.keys(exts).length} extensions → ${out}`,
);
