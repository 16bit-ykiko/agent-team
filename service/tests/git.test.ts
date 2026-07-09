import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitBranch, getPrInfo } from "../src/git";

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

describe("gitBranch", () => {
  it("returns the current branch of a repo", async () => {
    expect(await gitBranch(repo)).toBe("test-branch");
  });

  it("returns null outside a repo and for missing directories", async () => {
    expect(await gitBranch(plain)).toBeNull();
    expect(await gitBranch("/definitely/not/here")).toBeNull();
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
