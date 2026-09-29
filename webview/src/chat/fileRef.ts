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
// Files known by name alone.
const FILE_NAME =
  /^(Makefile|GNUmakefile|Dockerfile|Containerfile|Justfile|LICENSE|README|CHANGELOG|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.prettierrc|\.prettierignore|\.npmrc|\.nvmrc|\.clang-format|\.clang-tidy|\.clangd|\.env(\.\w+)?)$/;
// Regexes, globs, shell and Windows paths (the server resolves POSIX ones).
const NOT_A_PATH = /[\\*+?^$|(){}<>"'`,;]|^[A-Za-z]:\//;
// "example.com/index.html" is a site, not a folder.
const DOMAIN = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|ai|co|cn|me|so)$/i;

// "path", "path:12", "path:12-20", "path:12:5", "path#L12-L20", "path#12";
// another anchor ("guide.md#setup") is dropped.
export function parseFileRef(text: string): FileRef | null {
  const s = text.trim();
  if (!s || /\s/.test(s) || s.includes("://") || NOT_A_PATH.test(s)) return null;
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L?(\d+)(?:-L?(\d+))?|#[\w.-]*)?$/.exec(s);
  if (!m) return null;
  const path = m[1];
  const anchored = /^(\/|~\/|\.\.?\/)/.test(path);
  const segments = path.split("/");
  const last = segments.at(-1) ?? "";
  // A slash command or a route ("/compact"), not a folder.
  if (/^\/[^/.]+$/.test(path)) return null;
  if (!anchored && DOMAIN.test(segments[0]) && segments.length > 1) return null;
  if (!anchored && !path.endsWith("/") && !FILE_EXT.test(last) && !FILE_NAME.test(last)) {
    return null;
  }
  const line = Number(m[2] ?? m[4]) || undefined;
  const endLine = Number(m[3] ?? m[5]) || undefined;
  return { path, ...(line && { line }), ...(endLine && endLine > (line ?? 0) && { endLine }) };
}

// What a markdown link points at, as a file reference to open: its href
// decoded, without "file://" or a query. Null for other schemes and for
// anchors within the page.
export function linkFileRef(href: string): string | null {
  let s = href.replace(/^file:\/\//i, "");
  try {
    s = decodeURI(s);
  } catch {
    // Not percent-encoded after all.
  }
  s = s.replace(/\?[^#]*/, "");
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/#(?!L?\d)[^#]*$/, "");
  if (/^[a-z][a-z0-9+-]*:(?!\d)/i.test(s)) return null;
  return s;
}
