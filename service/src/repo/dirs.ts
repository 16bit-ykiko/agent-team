import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Shell-style directory completion for the new-workspace path field.
// "/home/yk"  → directories in /home starting with "yk"
// "/home/"    → directories in /home
// "~/wo"      → ~ expands to the home directory
// Hidden directories only appear when the partial itself starts with ".".
export function completeDirs(prefix: string, limit = 50): string[] {
  let p = prefix.trim();
  if (!p) p = os.homedir() + path.sep;
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
    if (prefix.trim() === "~" || prefix.trim().endsWith("/")) p += path.sep;
  }
  if (!path.isAbsolute(p)) return [];

  const endsWithSep = p.endsWith(path.sep);
  const dir = endsWithSep ? p : path.dirname(p);
  const partial = endsWithSep ? "" : path.basename(p);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const isDir = (e: fs.Dirent): boolean => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(dir, e.name)).isDirectory();
    } catch {
      return false;
    }
  };

  return entries
    .filter((e) => e.name.startsWith(partial))
    .filter((e) => partial.startsWith(".") || !e.name.startsWith("."))
    .filter(isDir)
    .map((e) => e.name)
    .sort()
    .slice(0, limit)
    .map((n) => path.join(dir, n) + path.sep);
}

// Expand ~ and normalize; returns null unless the result is an existing directory.
export function resolveWorkspacePath(input: string): string | null {
  let p = input.trim();
  if (!p) return null;
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) return null;
  p = path.resolve(p);
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}
