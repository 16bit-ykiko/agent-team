import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitBranch, gitStatus, getPrInfo, parseGitStatus, parsePrJson } from "../src/git";

let repo: string;
let plain: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-repo-"));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-plain-"));
  execSync(
    "git init -q -b test-branch && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
    { cwd: repo },
  );
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

describe("gitStatus", () => {
  it("returns the branch and counts dirty files", async () => {
    expect(await gitBranch(repo)).toBe("test-branch");
    expect(await gitStatus(repo)).toEqual({ branch: "test-branch", dirty: 0, ahead: 0, behind: 0 });
    fs.writeFileSync(path.join(repo, "new.txt"), "x");
    expect((await gitStatus(repo))!.dirty).toBe(1);
  });

  it("returns null outside a repo and for missing directories", async () => {
    expect(await gitStatus(plain)).toBeNull();
    expect(await gitBranch("/definitely/not/here")).toBeNull();
  });
});

describe("parseGitStatus", () => {
  it("reads head, ahead/behind and entries from porcelain v2", () => {
    const text = [
      "# branch.oid abc",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 a a src/a.ts",
      "? untracked.txt",
      "",
    ].join("\n");
    expect(parseGitStatus(text)).toEqual({ branch: "feat/x", dirty: 2, ahead: 2, behind: 1 });
  });

  it("reports a detached head as HEAD", () => {
    expect(parseGitStatus("# branch.head (detached)\n").branch).toBe("HEAD");
  });
});

describe("parsePrJson", () => {
  const base = { number: 42, url: "https://x/pull/42", title: "T", state: "OPEN", isDraft: false };

  it("maps state, draft and rolled-up checks", () => {
    expect(parsePrJson({ ...base, statusCheckRollup: [] })).toEqual({
      number: 42,
      url: "https://x/pull/42",
      title: "T",
      state: "open",
      draft: false,
      checks: null,
    });
    expect(
      parsePrJson({
        ...base,
        isDraft: true,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "IN_PROGRESS" },
        ],
      }),
    ).toMatchObject({ draft: true, checks: "pending" });
    expect(
      parsePrJson({
        ...base,
        state: "MERGED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "FAILURE" }],
      }),
    ).toMatchObject({ state: "merged", checks: "failure" });
    expect(
      parsePrJson({
        ...base,
        state: "CLOSED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SKIPPED" }],
      }),
    ).toMatchObject({ state: "closed", checks: "success" });
  });

  it("rejects payloads without a url", () => {
    expect(parsePrJson({})).toBeNull();
    expect(parsePrJson(null)).toBeNull();
  });
});

describe("getPrInfo", () => {
  it("skips main/master/HEAD/no-branch without spawning gh", async () => {
    expect(await getPrInfo(repo, "main")).toBeNull();
    expect(await getPrInfo(repo, "master")).toBeNull();
    expect(await getPrInfo(repo, "HEAD")).toBeNull();
    expect(await getPrInfo(repo, null)).toBeNull();
  });
});
