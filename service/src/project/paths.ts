import { execFile } from "child_process";
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
  const reals = [root, notesDir].map(realOr);
  if (![root, notesDir, ...reals].some((b) => within(b, abs))) return null;
  return reals.some((b) => within(b, realNear(abs))) ? abs : null;
}

// What a path missing from the repository may mean: the files (or folders)
// of the repository, ignored ones aside, and of the notes whose paths end
// with it, each as the board writes it and in full. Leads write paths from
// the folder they think in (sched/batch.cpp for src/sched/batch.cpp): one
// match is the file, several a choice.
export async function findBySuffix(
  input: string,
  root: string,
  notesDir: string,
): Promise<Array<{ ref: string; abs: string }>> {
  const p = input.trim().replace(/\/+$/, "");
  if (!p || /^(\.{1,2}|~|notes)(\/|$)/.test(p) || path.isAbsolute(p)) return [];
  const found = new Map<string, string>();
  const look = (base: string, prefix: string, files: string[]) => {
    for (const f of files) {
      for (let at = `/${f}`.indexOf(`/${p}`); at >= 0; at = `/${f}`.indexOf(`/${p}`, at + 1)) {
        const end = at + p.length;
        if (end !== f.length && f[end] !== "/") continue;
        const abs = resolveProjectPath(path.join(base, f.slice(0, end)), root, notesDir);
        if (abs) found.set(prefix + f.slice(0, end), abs);
      }
    }
  };
  look(root, "", await repoFiles(root));
  look(notesDir, "notes/", listFiles(notesDir));
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([ref, abs]) => ({ ref, abs }));
}

const listed = new Map<string, { at: number; files: Promise<string[]> }>();

function repoFiles(root: string): Promise<string[]> {
  const hit = listed.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files = new Promise<string[]>((resolve) =>
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf-8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : stdout.split("\0").filter(Boolean)),
    ),
  );
  listed.set(root, { at: Date.now(), files });
  return files;
}

function listFiles(dir: string, rel = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, p) : [p];
  });
}

function within(dir: string, p: string): boolean {
  const r = path.relative(dir, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The real path of `p`, or of its nearest existing folder with the rest
// appended: a file not there yet still cannot be reached through a symlink
// out of the repository.
function realNear(p: string): string {
  let rest = "";
  for (let dir = p; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return p;
      rest = path.join(path.basename(dir), rest);
    }
  }
}
