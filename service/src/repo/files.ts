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

// Only regular files are opened: a FIFO would block until a writer shows up.
export class NotRegularFile extends Error {
  constructor() {
    super("Not a regular file");
  }
}

// Asynchronous throughout: a huge folder or a slow mount must not stall the
// server's event loop.
export async function readFileView(abs: string): Promise<FileView> {
  const stat = await fs.promises.stat(abs);
  if (stat.isDirectory()) {
    const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<DirEntry> => {
        try {
          const s = await fs.promises.stat(path.join(abs, d.name));
          return { name: d.name, dir: s.isDirectory(), size: s.size };
        } catch {
          // A dangling symlink: listed, not followed.
          return { name: d.name, dir: d.isDirectory(), size: 0 };
        }
      }),
    );
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return {
      kind: "dir",
      path: abs,
      entries: entries.slice(0, DIR_LIMIT),
      truncated: entries.length > DIR_LIMIT,
    };
  }
  if (!stat.isFile()) throw new NotRegularFile();
  if (IMAGE_EXTS.has(path.extname(abs).toLowerCase())) {
    return { kind: "image", path: abs, size: stat.size };
  }
  const file = await fs.promises.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (looksBinary(bytes.subarray(0, 8192))) return { kind: "binary", path: abs, size: stat.size };
    return {
      kind: "text",
      path: abs,
      size: stat.size,
      content: bytes.toString("utf-8"),
      truncated: stat.size > bytesRead,
    };
  } finally {
    await file.close();
  }
}
