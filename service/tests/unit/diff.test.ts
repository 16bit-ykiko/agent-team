// A branch's changes against its base, in a real repository: a clone of an
// "origin" with a feature branch, committed and uncommitted work.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { changes, fileDiff, NotARepository } from "../../src/repo/diff";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-diff-"));
  dirs.push(tmp);
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd,
      stdio: "pipe",
      encoding: "utf-8",
    });
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  const lines = (n: number, w = "line") =>
    Array.from({ length: n }, (_, i) => `${w} ${i}`).join("\n") + "\n";
  fs.writeFileSync(path.join(origin, "a.txt"), lines(5));
  fs.writeFileSync(path.join(origin, "c.txt"), "gone\n");
  fs.writeFileSync(path.join(origin, "d.txt"), lines(20, "keep"));
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const work = path.join(tmp, "work");
  git(tmp, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "feature");
  const write = (f: string, s: string | Buffer) => fs.writeFileSync(path.join(work, f), s);
  write("a.txt", lines(5).replace("line 2", "line two"));
  write("b.txt", "new\nfile\n");
  fs.rmSync(path.join(work, "c.txt"));
  git(work, "mv", "d.txt", "e.txt");
  write("g.bin", Buffer.from([0, 1, 2, 3]));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "work");
  // Not committed yet, and not in git yet.
  write("a.txt", lines(5).replace("line 2", "line two").replace("line 4", "line four"));
  write("f.txt", "one\ntwo\nthree\n");
  return { tmp, origin, work, git };
}

describe("a branch's changes", () => {
  it("lists what changed since the base, committed or not, and what git does not know yet", async () => {
    const { work } = repo();
    const c = await changes(path.join(work));
    expect(c).toMatchObject({
      top: work,
      branch: "feature",
      base: "origin/main",
      truncated: false,
    });
    expect(c.against).toMatch(/^[0-9a-f]{40}$/);
    expect(c.files).toEqual([
      { path: "a.txt", status: "modified", added: 2, removed: 2 },
      { path: "b.txt", status: "added", added: 2, removed: 0 },
      { path: "c.txt", status: "deleted", added: 0, removed: 1 },
      { path: "e.txt", oldPath: "d.txt", status: "renamed", added: 0, removed: 0 },
      { path: "f.txt", status: "untracked", added: 3, removed: 0 },
      { path: "g.bin", status: "added", added: null, removed: null },
    ]);
  });

  it("gives a file's diff from its first hunk; an untracked file as all new", async () => {
    const { work } = repo();
    const { against } = await changes(work);
    const a = await fileDiff(work, { path: "a.txt" }, against);
    expect(a.diff.startsWith("@@ ")).toBe(true);
    expect(a.diff).toContain("-line 2\n+line two");
    expect(a.diff).toContain("+line four");
    const f = await fileDiff(work, { path: "f.txt", untracked: true }, against);
    expect(f.diff).toContain("+one\n+two\n+three");
    expect(await fileDiff(work, { path: "e.txt", oldPath: "d.txt" }, against)).toMatchObject({
      diff: "",
      binary: false,
    });
    expect(await fileDiff(work, { path: "g.bin" }, against)).toMatchObject({ binary: true });
  });

  it("takes the pull request's base when it has one", async () => {
    const { origin, work, git } = repo();
    git(origin, "branch", "release");
    git(work, "fetch", "-q", "origin");
    expect((await changes(work, "release")).base).toBe("origin/release");
    expect((await changes(work, "no-such-branch")).base).toBe("origin/main");
  });

  it("with no base, shows what is not committed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-diff-"));
    dirs.push(tmp);
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "x.txt"), "x\n");
    const c = await changes(tmp);
    expect(c).toMatchObject({ base: null, branch: "trunk" });
    expect(c.files).toEqual([{ path: "x.txt", status: "untracked", added: 1, removed: 0 }]);
  });

  it("stays in the repository and says when there is none", async () => {
    const { work } = repo();
    const { against } = await changes(work);
    for (const p of ["../origin/a.txt", "/etc/passwd", "-p"]) {
      await expect(fileDiff(work, { path: p }, against)).rejects.toThrow(
        "Not a path in the repository",
      );
    }
    await expect(fileDiff(work, { path: "a.txt" }, "HEAD; rm -rf /")).rejects.toThrow(
      "Not a commit",
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-nogit-"));
    dirs.push(outside);
    await expect(changes(outside)).rejects.toBeInstanceOf(NotARepository);
  });
});
