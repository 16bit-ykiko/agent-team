import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

// A branch's changes against where it left its base branch, the working
// tree included: what a review of it would show, before it is even
// committed. The base is the pull request's, else the remote's default
// branch; without one, the changes not yet committed.

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  // From the repository's top folder.
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  // Lines; null for a binary file.
  added: number | null;
  removed: number | null;
}

export interface Changes {
  // The repository (or worktree) folder.
  top: string;
  branch: string | null;
  base: string | null;
  // What the files are compared with: a commit, or HEAD without a base.
  against: string;
  files: ChangedFile[];
  truncated: boolean;
}

export interface FileDiff {
  path: string;
  // Unified, from its first hunk.
  diff: string;
  binary: boolean;
  truncated: boolean;
}

export class NotARepository extends Error {
  constructor(dir: string) {
    super(`Not in a git repository: ${dir}`);
  }
}

const MAX_FILES = 2000;
const MAX_DIFF = 2 * 1024 * 1024;
// A repository with no commit yet is compared with nothing.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// stdout, also for the exit codes in `ok` (git diff --no-index exits 1 when
// the files differ); null when git fails.
function git(cwd: string, args: string[], ok: number[] = []): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (!err) resolve(stdout);
        else resolve(typeof err.code === "number" && ok.includes(err.code) ? stdout : null);
      },
    );
  });
}

const verify = async (top: string, ref: string) =>
  (await git(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;

async function baseOf(top: string, prBase?: string | null): Promise<string | null> {
  const remoteHead = (
    await git(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  )?.trim();
  const candidates = [
    prBase && `origin/${prBase}`,
    prBase,
    remoteHead,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (await verify(top, c)) return c;
  return null;
}

// `git diff --name-status -z`: a status, then one path, two for a rename.
function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const code = parts[i++];
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[i++];
      const p = parts[i++];
      files.push({
        path: p,
        ...(code.startsWith("R") && { oldPath }),
        status: code.startsWith("R") ? "renamed" : "added",
        added: 0,
        removed: 0,
      });
    } else {
      const status: ChangeStatus = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      files.push({ path: parts[i++], status, added: 0, removed: 0 });
    }
  }
  return files;
}

// `git diff --numstat -z`: "added\tremoved\tpath", or for a rename
// "added\tremoved\t" then the two paths; "-" for a binary file.
function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const parts = out.split("\0");
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  for (let i = 0; i < parts.length - 1;) {
    const [a, r, p] = parts[i++].split("\t");
    const target = p === "" ? (i++, parts[i++]) : p;
    stats.set(target, {
      added: a === "-" ? null : Number(a),
      removed: r === "-" ? null : Number(r),
    });
  }
  return stats;
}

// Lines of a file not in git yet; null when it looks binary or is huge.
function lineCount(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_DIFF) return null;
    const data = fs.readFileSync(file);
    if (data.includes(0)) return null;
    const text = data.toString("utf-8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

export async function changes(dir: string, prBase?: string | null): Promise<Changes> {
  const top = (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) throw new NotARepository(dir);
  // Detached: none. Named even before the first commit.
  const branch = (await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
  const base = await baseOf(top, prBase);
  const fork = base ? (await git(top, ["merge-base", base, "HEAD"]))?.trim() : null;
  const against = fork || ((await verify(top, "HEAD")) ? "HEAD" : EMPTY_TREE);
  const [names, nums, others] = await Promise.all([
    git(top, ["diff", "--name-status", "-z", "-M", against]),
    git(top, ["diff", "--numstat", "-z", "-M", against]),
    git(top, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const stats = parseNumstat(nums ?? "");
  const files = parseNameStatus(names ?? "").map((f) => ({
    ...f,
    ...(stats.get(f.path) ?? { added: null, removed: null }),
  }));
  for (const p of (others ?? "").split("\0").filter(Boolean)) {
    files.push({ path: p, status: "untracked", added: lineCount(path.join(top, p)), removed: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    top,
    branch,
    base: fork ? base : null,
    against,
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}

// A path in the repository as the list gave it: relative, never out of it.
function checkPath(p: string): string {
  const n = path.posix.normalize(p);
  if (!p || path.isAbsolute(p) || n.startsWith("../") || n === ".." || p.startsWith("-")) {
    throw new Error(`Not a path in the repository: ${p}`);
  }
  return n;
}

export async function fileDiff(
  dir: string,
  file: { path: string; oldPath?: string; untracked?: boolean },
  against: string,
): Promise<FileDiff> {
  if (!/^([0-9a-f]{7,40}|HEAD)$/.test(against)) throw new Error(`Not a commit: ${against}`);
  const top = (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) throw new NotARepository(dir);
  const p = checkPath(file.path);
  const out = file.untracked
    ? await git(top, ["diff", "--no-index", "--no-color", "--", "/dev/null", p], [1])
    : await git(top, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-M",
        against,
        "--",
        ...(file.oldPath ? [checkPath(file.oldPath)] : []),
        p,
      ]);
  if (out === null) throw new Error(`git could not compare ${p}`);
  const at = out.search(/^@@ /m);
  const binary = at < 0 && /^Binary files /m.test(out);
  const diff = at < 0 ? "" : out.slice(at);
  return {
    path: p,
    diff: diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) : diff,
    binary,
    truncated: diff.length > MAX_DIFF,
  };
}
