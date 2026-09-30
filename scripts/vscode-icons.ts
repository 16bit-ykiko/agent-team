// Takes the file and folder icons of the vscode-icons extension from an
// install of it: the SVGs, their license, and which file or folder gets
// which, as VS Code picks it — a file by name, by extension (the longest
// first), by the language VS Code gives it, else the default; a folder by
// name, else the default. Languages come from VS Code (its resources/app)
// and the extensions installed beside it (~/.vscode/extensions), which add
// languages such as CMake's and TOML's.
//
//   npm run vscode-icons -- <vscode-icons extension dir> <vscode>/resources/app ~/.vscode/extensions
import * as fs from "fs";
import * as path from "path";

const [ext, ...sources] = process.argv.slice(2);
if (!ext || sources.length === 0) {
  throw new Error("usage: npm run vscode-icons -- <vscode-icons dir> <dir with extensions>...");
}
// Where extensions are: a VS Code install's, or a folder of them.
const extensionDirs = sources.map((d) =>
  fs.existsSync(path.join(d, "extensions")) ? path.join(d, "extensions") : d,
);
const root = path.resolve(import.meta.dirname, "..", "webview");
const svgOut = path.join(root, "public", "file-icons");
const tableOut = path.join(root, "src", "panels", "vscode-icons.json");

interface IconTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  file: string;
  folder: string;
  folderNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}
interface Language {
  id: string;
  extensions?: string[];
  filenames?: string[];
}

const theme = JSON.parse(
  fs.readFileSync(path.join(ext, "dist", "src", "vsicons-icon-theme.json"), "utf-8"),
) as IconTheme;

// Each icon once, by its SVG's name.
const icons: string[] = [];
const indexOf = new Map<string, number>();
const icon = (id: string): number => {
  let i = indexOf.get(id);
  if (i === undefined) {
    i = icons.push(path.basename(theme.iconDefinitions[id].iconPath, ".svg")) - 1;
    indexOf.set(id, i);
  }
  return i;
};

const names: Record<string, number> = {};
const exts: Record<string, number> = {};
const folders: Record<string, number> = {};
// Languages first, the theme's own names and extensions over them.
for (const manifest of extensionDirs.flatMap((d) =>
  fs.readdirSync(d).map((x) => path.join(d, x, "package.json")),
)) {
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
    contributes?: { languages?: Language[] };
  };
  for (const lang of pkg.contributes?.languages ?? []) {
    const id = theme.languageIds[lang.id];
    if (!id) continue;
    for (const e of lang.extensions ?? []) exts[e.replace(/^\./, "").toLowerCase()] ??= icon(id);
    for (const n of lang.filenames ?? []) names[n.toLowerCase()] ??= icon(id);
  }
}
for (const [e, id] of Object.entries(theme.fileExtensions)) exts[e.toLowerCase()] = icon(id);
for (const [n, id] of Object.entries(theme.fileNames)) names[n.toLowerCase()] = icon(id);
for (const [n, id] of Object.entries(theme.folderNames)) folders[n.toLowerCase()] = icon(id);
const file = icon(theme.file);
const folder = icon(theme.folder);

fs.rmSync(svgOut, { recursive: true, force: true });
fs.mkdirSync(svgOut, { recursive: true });
let bytes = 0;
for (const name of icons) {
  const from = path.join(ext, "icons", `${name}.svg`);
  fs.copyFileSync(from, path.join(svgOut, `${name}.svg`));
  bytes += fs.statSync(from).size;
}
fs.writeFileSync(
  path.join(svgOut, "LICENSE.txt"),
  [
    "These icons are from vscode-icons (https://github.com/vscode-icons/vscode-icons),",
    "licensed under Creative Commons Attribution-ShareAlike 4.0",
    "(https://creativecommons.org/licenses/by-sa/4.0/); branded icons under their",
    "own copyright. The extension's source code is MIT licensed.",
    "",
  ].join("\n"),
);
fs.writeFileSync(tableOut, `${JSON.stringify({ file, folder, icons, names, exts, folders })}\n`);
console.log(
  `${icons.length} icons (${(bytes / 1e6).toFixed(1)} MB), ${Object.keys(names).length} names, ${Object.keys(exts).length} extensions, ${Object.keys(folders).length} folders`,
);
