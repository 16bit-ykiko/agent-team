import { gitStatus, getPrInfo, type GitInfo, type PrInfo } from "./git";

// What the scanner keeps up to date: anything that works in a folder.
export interface GitTarget {
  cwd: string;
  git: GitInfo | null;
  pr: PrInfo | null;
}

interface FolderState {
  git: GitInfo | null;
  pr: PrInfo | null;
  prBranch: string | null;
  prFetchedAt: number;
}

// Branch and PR info per folder. One scan per folder, not per workspace (a
// folder often hosts many workspaces). `git status` is cheap and runs every
// tick; `gh pr view` is a network call, refreshed on branch change, after a
// turn ends, or once a minute. A pass still in flight skips the next tick
// instead of piling up.
export class GitScanner<T extends GitTarget> {
  private scanning = false;
  private cache = new Map<string, FolderState>();

  constructor(
    private targets: () => T[],
    private onChange: (target: T) => void,
  ) {}

  // The folder's last known state, to seed a new target from the first frame.
  cached(cwd: string): { git: GitInfo | null; pr: PrInfo | null } | undefined {
    return this.cache.get(cwd);
  }

  requestPrRefresh(cwd: string): void {
    const entry = this.cache.get(cwd);
    if (entry) entry.prFetchedAt = 0;
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const live = this.targets();
      const cwds = [...new Set(live.map((t) => t.cwd))];
      for (const cwd of this.cache.keys()) {
        if (!cwds.includes(cwd)) this.cache.delete(cwd);
      }
      await Promise.all(
        cwds.map((cwd) =>
          this.scanFolder(
            cwd,
            live.filter((t) => t.cwd === cwd),
          ),
        ),
      );
    } finally {
      this.scanning = false;
    }
  }

  private async scanFolder(cwd: string, targets: T[]): Promise<void> {
    const first = !this.cache.has(cwd);
    const entry = this.cache.get(cwd) ?? { git: null, pr: null, prBranch: null, prFetchedAt: 0 };
    this.cache.set(cwd, entry);

    // Keep the cached objects when nothing changed so targets can be
    // compared by identity below.
    const git = await gitStatus(cwd);
    if (first || !sameGit(entry.git, git)) entry.git = git;
    const branch = entry.git?.branch ?? null;

    const branchChanged = branch !== entry.prBranch;
    if (branchChanged || Date.now() - entry.prFetchedAt >= 60_000) {
      entry.prFetchedAt = Date.now();
      entry.prBranch = branch;
      const pr = await getPrInfo(cwd, branch);
      // A failed lookup keeps the previous PR unless the branch moved, so a
      // flaky gh call does not make the link flicker.
      const next = pr ?? (branchChanged ? null : entry.pr);
      if (!samePr(entry.pr, next)) entry.pr = next;
    }

    // Push to every target that is out of date: the folder changed, or the
    // target never received this folder's info.
    for (const t of targets) {
      if (t.git === entry.git && t.pr === entry.pr) continue;
      t.git = entry.git;
      t.pr = entry.pr;
      this.onChange(t);
    }
  }
}

function sameGit(a: GitInfo | null, b: GitInfo | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind
  );
}

function samePr(a: PrInfo | null, b: PrInfo | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.state === b.state &&
    a.draft === b.draft &&
    a.checks === b.checks
  );
}
