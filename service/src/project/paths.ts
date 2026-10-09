import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// A path as a project's board writes it, made absolute: notes/... in the
// project's notes (./notes/... is the repository's), other relative paths
// in its repository, absolute ones as they are. Null when it lands outside
// both, by .. or through a symlink: the board reads and opens nothing else.
export function resolveProjectPath(input: string, root: string, notesDir: string): string | null {
  const p = input.trim();
  if (p.length > MAX_PATH) return null;
  const abs = /^notes(\/|$)/.test(p)
    ? path.resolve(notesDir, p.slice("notes".length).replace(/^\/+/, "") || ".")
    : p === "~" || p.startsWith("~/")
      ? path.join(os.homedir(), p.slice(1))
      : path.resolve(root, p);
  const reals = [root, notesDir].map(realOr);
  const base = [root, notesDir, ...reals].find((b) => within(b, abs));
  const real = base && realNear(base, abs);
  return real && reals.some((b) => within(b, real)) ? abs : null;
}

// How the board writes a path inside the project, read back by
// resolveProjectPath to the same file.
export function boardRef(abs: string, root: string, notesDir: string): string {
  for (const notes of [notesDir, realOr(notesDir)]) {
    if (within(notes, abs)) return path.join("notes", path.relative(notes, abs));
  }
  for (const repo of [root, realOr(root)]) {
    if (!within(repo, abs)) continue;
    const rel = path.relative(repo, abs) || ".";
    return /^(notes|~)(\/|$)/.test(rel) ? `./${rel}` : rel;
  }
  return abs;
}

// Linux's PATH_MAX: nothing longer can be opened anyway.
const MAX_PATH = 4096;

// What a path missing from the repository may mean: the files (or folders)
// of the repository, ignored ones aside, and of the notes whose paths end
// with it, each as the board writes it and in full. Leads write paths from
// the folder they think in (sched/batch.cpp for src/sched/batch.cpp): one
// match is the file, several a choice.
export async function findBySuffix(
  input: string,
  root: string,
  notesDir: string,
  limit = 20,
): Promise<Array<{ ref: string; abs: string }>> {
  const t = input.trim();
  const p = t.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!p || p.length > MAX_PATH || /^(notes|\.\.|~)(\/|$)/.test(t) || path.isAbsolute(p)) return [];
  // Matches by the path they would have, many files of one folder one match.
  const found = new Map<string, string>();
  const look = (base: string, board: (rel: string) => string, files: string[]) => {
    for (const f of files) {
      for (let at = `/${f}`.indexOf(`/${p}`); at >= 0; at = `/${f}`.indexOf(`/${p}`, at + 1)) {
        const end = at + p.length;
        if (end !== f.length && f[end] !== "/") continue;
        const ref = board(f.slice(0, end));
        if (found.has(ref)) continue;
        found.set(ref, path.join(base, f.slice(0, end)));
        if (found.size > limit) return;
      }
    }
  };
  const inRepo = (rel: string) => (/^(notes|~)(\/|$)/.test(rel) ? `./${rel}` : rel);
  look(root, inRepo, await repoFiles(root));
  if (found.size <= limit) look(notesDir, (rel) => `notes/${rel}`, listFiles(notesDir));
  return [...found]
    .filter(([ref, abs]) => fs.existsSync(abs) && resolveProjectPath(ref, root, notesDir) === abs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, abs]) => ({ ref, abs }));
}

const listed = new Map<string, { at: number; files: Promise<string[]> }>();

function repoFiles(root: string): Promise<string[]> {
  const hit = listed.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files = new Promise<string[]>((resolve) => {
    try {
      execFile(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, encoding: "utf-8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => resolve(err ? [] : stdout.split("\0").filter(Boolean)),
      );
    } catch {
      // Some spawn failures (a cwd that is a file: ENOTDIR) throw at once.
      resolve([]);
    }
  });
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

// The real path of `abs`, inside `base`: walked down one lstat a segment,
// so that a file not there yet still cannot be reached through a symlink
// out of the repository. Null past a symlink to nowhere, which may come to
// point anywhere.
function realNear(base: string, abs: string): string | null {
  let cur = realOr(base);
  const rest = path.relative(base, abs).split(path.sep).filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const next = path.join(cur, rest[i]);
    let link: boolean;
    try {
      link = fs.lstatSync(next).isSymbolicLink();
    } catch {
      return path.join(next, ...rest.slice(i + 1));
    }
    if (!link) cur = next;
    else {
      try {
        cur = fs.realpathSync(next);
      } catch {
        return null;
      }
    }
  }
  return cur;
}
