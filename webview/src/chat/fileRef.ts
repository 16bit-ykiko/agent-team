import { createContext } from "react";

// Opens a file reference ("src/a.ts:12-20", "/tmp/report.md") in the file
// viewer; null outside a workspace view, where references stay plain text.
export const FileOpenContext = createContext<((ref: string) => void) | null>(null);

export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

// Extensions that make a bare "name.ext" read as a file rather than code
// ("ws.send" is not one).
const FILE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|json|jsonl|md|mdx|txt|log|cpp|cc|cxx|c|h|hpp|hh|hxx|py|rs|go|java|kt|swift|rb|lua|sh|bash|zsh|fish|toml|ya?ml|ini|cfg|conf|css|scss|html?|xml|svg|sql|diff|patch|cmake|lock|csv|tex|bib|proto|zig|nix|png|jpe?g|gif|webp|pdf)$/i;

// "path", "path:12", "path:12-20", "path:12:5", "path#L12-L20".
export function parseFileRef(text: string): FileRef | null {
  const s = text.trim();
  if (!s || /\s/.test(s) || s.includes("://")) return null;
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)?$/.exec(s);
  if (!m) return null;
  const path = m[1];
  const anchored = /^(\/|~\/|\.\.?\/)/.test(path);
  const last = path.split("/").pop() ?? "";
  if (!anchored && !path.endsWith("/") && !FILE_EXT.test(last)) return null;
  const line = Number(m[2] ?? m[4]) || undefined;
  const endLine = Number(m[3] ?? m[5]) || undefined;
  return { path, ...(line && { line }), ...(endLine && endLine > (line ?? 0) && { endLine }) };
}
