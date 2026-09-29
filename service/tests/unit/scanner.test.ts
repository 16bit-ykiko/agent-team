// GitScanner with git/gh stubbed: when the PR lookup (a network call) runs,
// what survives a failed lookup, and which targets are told about changes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GitInfo, PrInfo } from "../../src/repo/git";

const git = vi.hoisted(() => ({
  status: new Map<string, GitInfo | null>(),
  pr: new Map<string, PrInfo | null>(),
  prCalls: [] as Array<[string, string | null]>,
  statusGate: null as Promise<void> | null,
}));

vi.mock("../../src/repo/git", () => ({
  gitStatus: async (cwd: string) => {
    if (git.statusGate) await git.statusGate;
    return git.status.get(cwd) ?? null;
  },
  getPrInfo: (cwd: string, branch: string | null) => {
    git.prCalls.push([cwd, branch]);
    return Promise.resolve(git.pr.get(`${cwd}@${branch}`) ?? null);
  },
}));

import { GitScanner, type GitTarget } from "../../src/repo/scanner";

const info = (branch: string, dirty = 0): GitInfo => ({ branch, dirty, ahead: 0, behind: 0 });
const pr = (n: number): PrInfo => ({
  number: n,
  url: `u${n}`,
  title: `t${n}`,
  state: "open",
  draft: false,
  checks: null,
});

interface T extends GitTarget {
  id: string;
}
const target = (id: string, cwd: string): T => ({ id, cwd, git: null, pr: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  git.status.clear();
  git.pr.clear();
  git.prCalls.length = 0;
  git.statusGate = null;
});
afterEach(() => vi.useRealTimers());

describe("GitScanner", () => {
  it("looks a PR up once a minute, again on request or branch change", async () => {
    const t = target("a", "/r");
    const changed: string[] = [];
    const s = new GitScanner(
      () => [t],
      (x) => changed.push(x.id),
    );
    git.status.set("/r", info("feat"));
    git.pr.set("/r@feat", pr(1));

    await s.scan();
    expect(git.prCalls).toEqual([["/r", "feat"]]);
    expect(t.pr).toMatchObject({ url: "u1" });
    expect(changed).toEqual(["a"]);

    await s.scan();
    expect(git.prCalls).toHaveLength(1);
    expect(changed).toEqual(["a"]);

    // A turn ended: refresh on the next scan instead of waiting a minute.
    s.requestPrRefresh("/r");
    await s.scan();
    expect(git.prCalls).toHaveLength(2);

    vi.setSystemTime(1_000_000 + 60_000);
    await s.scan();
    expect(git.prCalls).toHaveLength(3);

    git.status.set("/r", info("other"));
    await s.scan();
    expect(git.prCalls.at(-1)).toEqual(["/r", "other"]);
    expect(t.pr).toBeNull();
    expect(t.git).toMatchObject({ branch: "other" });
    expect(changed).toEqual(["a", "a"]);
  });

  it("keeps the last PR through a failed lookup on the same branch", async () => {
    const t = target("a", "/r");
    const s = new GitScanner(
      () => [t],
      () => {},
    );
    git.status.set("/r", info("feat"));
    git.pr.set("/r@feat", pr(1));
    await s.scan();
    const first = t.pr;

    git.pr.delete("/r@feat");
    s.requestPrRefresh("/r");
    await s.scan();
    expect(t.pr).toBe(first);
  });

  it("scans a shared folder once, seeds new targets from the cache and forgets gone folders", async () => {
    const a = target("a", "/r");
    const b = target("b", "/r");
    let live: T[] = [a, b];
    const changed: string[] = [];
    const s = new GitScanner(
      () => live,
      (x) => changed.push(x.id),
    );
    git.status.set("/r", info("feat", 1));
    git.pr.set("/r@feat", pr(1));
    await s.scan();
    expect(git.prCalls).toHaveLength(1);
    expect(changed).toEqual(["a", "b"]);
    expect(a.git).toBe(b.git);
    expect(s.cached("/r")).toMatchObject({ git: { dirty: 1 }, pr: { url: "u1" } });

    // Same status, new object from git: targets keep the identical object.
    git.status.set("/r", info("feat", 1));
    await s.scan();
    expect(changed).toEqual(["a", "b"]);

    live = [];
    await s.scan();
    expect(s.cached("/r")).toBeUndefined();
  });

  it("skips a tick while the previous pass is still running", async () => {
    const t = target("a", "/r");
    const s = new GitScanner(
      () => [t],
      () => {},
    );
    git.status.set("/r", info("feat"));
    let open!: () => void;
    git.statusGate = new Promise<void>((r) => (open = r));
    const first = s.scan();
    await s.scan();
    open();
    await first;
    expect(git.prCalls).toHaveLength(1);
  });
});
