import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Read-only file preview for the web UI. Any path the server user can read:
// the agents behind this panel already run with full access, and agents
// point at files outside their workspace (/tmp reports, other checkouts).

export const TEXT_LIMIT = 1024 * 1024;
const DIR_LIMIT = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

export interface DirEntry {
  name: string;
  dir: boolean;
  size: number;
}

export type FileView =
  | { kind: "dir"; path: string; entries: DirEntry[]; truncated: boolean }
  | { kind: "text"; path: string; size: number; content: string; truncated: boolean }
  | { kind: "image" | "binary"; path: string; size: number };

// "~/x" is under home, a relative path under the workspace directory.
export function resolveFilePath(cwd: string, input: string): string {
  const p = input.trim();
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function looksBinary(head: Buffer): boolean {
  if (head.includes(0)) return true;
  // Mostly control bytes (other than whitespace) is not text either.
  let control = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) control++;
  return head.length > 0 && control / head.length > 0.1;
}

export function readFileView(abs: string): FileView {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const dirents = fs.readdirSync(abs, { withFileTypes: true });
    const entries = dirents.slice(0, DIR_LIMIT).map((d): DirEntry => {
      let dir = d.isDirectory();
      let size = 0;
      try {
        const s = fs.statSync(path.join(abs, d.name));
        dir = s.isDirectory();
        size = s.size;
      } catch {
        // A dangling symlink: listed, not followed.
      }
      return { name: d.name, dir, size };
    });
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { kind: "dir", path: abs, entries, truncated: dirents.length > DIR_LIMIT };
  }
  if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) {
    return { kind: "image", path: abs, size: stat.size };
  }
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, read);
    if (looksBinary(bytes.subarray(0, 8192))) return { kind: "binary", path: abs, size: stat.size };
    return {
      kind: "text",
      path: abs,
      size: stat.size,
      content: bytes.toString("utf-8"),
      truncated: stat.size > read,
    };
  } finally {
    fs.closeSync(fd);
  }
}
