import table from "./vscode-icons.json";

// The panels' icons: 16px line drawings in one stroke, so the rail, the
// panel headers and the row actions read as one family.
export const ICONS = {
  board: "M2.5 3.5h11v9h-11zM6.2 3.5v9M9.8 3.5v9",
  agents: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.2 2.6-3.5 5-3.5s4.4 1.3 5 3.5",
  files: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  maximize: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  restore: "M6 2.5V6H2.5M10 2.5V6h3.5M10 13.5V10h3.5M6 13.5V10H2.5",
  pin: "M2.5 3.5h11v9h-11zM10 3.5v9",
  close: "M4 4l8 8M12 4l-8 8",
  clear: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7",
  up: "M8 13V3M4 7l4-4 4 4",
  changes: "M8 2.5v6M5 5.5h6M5 12.5h6",
  play: "M5 3.5v9l7.5-4.5z",
  plus: "M8 3.5v9M3.5 8h9",
  snapshot: "M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

interface IconTable {
  file: number;
  folder: number;
  // The icons' SVG names (public/file-icons/<name>.svg).
  icons: string[];
  names: Record<string, number>;
  exts: Record<string, number>;
  folders: Record<string, number>;
}
const TABLE = table as IconTable;

// The icon vscode-icons gives a file or folder in VS Code: a file by its
// name, its longest extension, its language (folded into both by
// scripts/vscode-icons.ts), else the default one; a folder by its name.
export function fileIconName(name: string, dir = false): string {
  const base = (name.replace(/\/+$/, "").split("/").pop() ?? name).toLowerCase();
  if (dir) return TABLE.icons[TABLE.folders[base] ?? TABLE.folder];
  let i: number | undefined = TABLE.names[base];
  const parts = base.split(".");
  for (let k = 1; i === undefined && k < parts.length; k++)
    i = TABLE.exts[parts.slice(k).join(".")];
  return TABLE.icons[i ?? TABLE.file];
}

export function FileIcon({ name, dir = false }: { name: string; dir?: boolean }) {
  return (
    <img
      className="file-icon"
      src={`file-icons/${fileIconName(name, dir)}.svg`}
      alt=""
      width={16}
      height={16}
      draggable={false}
    />
  );
}
