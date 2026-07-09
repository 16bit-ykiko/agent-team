import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { completeDirs, resolveWorkspacePath } from "../src/dirs";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dirs-test-"));
  for (const d of ["alpha", "alps", "beta", ".hidden"]) {
    fs.mkdirSync(path.join(root, d));
  }
  fs.writeFileSync(path.join(root, "alpine.txt"), "not a dir");
  fs.mkdirSync(path.join(root, "alpha", "nested"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("completeDirs", () => {
  it("lists all visible directories for a trailing-slash prefix", () => {
    const dirs = completeDirs(root + "/");
    expect(dirs).toEqual([
      path.join(root, "alpha") + "/",
      path.join(root, "alps") + "/",
      path.join(root, "beta") + "/",
    ]);
  });

  it("filters by partial name and excludes files", () => {
    const dirs = completeDirs(path.join(root, "alp"));
    // "alpine.txt" is a file and must not appear even though it matches.
    expect(dirs).toEqual([path.join(root, "alpha") + "/", path.join(root, "alps") + "/"]);
  });

  it("shows hidden directories only when the partial starts with a dot", () => {
    expect(completeDirs(root + "/")).not.toContain(path.join(root, ".hidden") + "/");
    expect(completeDirs(path.join(root, ".hi"))).toEqual([path.join(root, ".hidden") + "/"]);
  });

  it("descends into subdirectories", () => {
    expect(completeDirs(path.join(root, "alpha") + "/")).toEqual([
      path.join(root, "alpha", "nested") + "/",
    ]);
  });

  it("returns [] for nonexistent parents and relative paths", () => {
    expect(completeDirs("/definitely/not/a/real/path/x")).toEqual([]);
    expect(completeDirs("relative/path")).toEqual([]);
  });

  it("expands ~ to the home directory", () => {
    const dirs = completeDirs("~/");
    expect(dirs.every((d) => d.startsWith(os.homedir() + path.sep))).toBe(true);
  });
});

describe("resolveWorkspacePath", () => {
  it("accepts existing directories and normalizes the path", () => {
    expect(resolveWorkspacePath(root + "/alpha/")).toBe(path.join(root, "alpha"));
    expect(resolveWorkspacePath(`${root}/alpha/../beta`)).toBe(path.join(root, "beta"));
  });

  it("rejects files, missing paths, relative paths, and empty input", () => {
    expect(resolveWorkspacePath(path.join(root, "alpine.txt"))).toBeNull();
    expect(resolveWorkspacePath(path.join(root, "nope"))).toBeNull();
    expect(resolveWorkspacePath("relative")).toBeNull();
    expect(resolveWorkspacePath("  ")).toBeNull();
  });

  it("expands ~", () => {
    expect(resolveWorkspacePath("~")).toBe(os.homedir());
  });
});
