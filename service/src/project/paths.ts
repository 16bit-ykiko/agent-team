import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// A path as a project's board writes it, made absolute: notes/... in the
// project's notes, other relative paths in its repository, absolute ones as
// they are. Null when it lands outside both, by .. or through a symlink:
// the board reads and opens nothing else.
export function resolveProjectPath(input: string, root: string, notesDir: string): string | null {
  const p = input.trim().replace(/^\.\//, "");
  const abs =
    p === "notes" || p.startsWith("notes/")
      ? path.resolve(notesDir, p.slice("notes".length).replace(/^\/+/, "") || ".")
      : p === "~" || p.startsWith("~/")
        ? path.join(os.homedir(), p.slice(1))
        : path.resolve(root, p);
  const bases = [root, notesDir];
  if (!bases.some((b) => within(b, abs))) return null;
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // Not there: reading it fails on its own.
    return abs;
  }
  return bases.some((b) => within(realOr(b), real)) ? abs : null;
}

function within(dir: string, p: string): boolean {
  const r = path.relative(dir, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
