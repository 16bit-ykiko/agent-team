import { execFile } from "child_process";

// Branch/PR lookups run on a timer across every live workspace folder, so
// they must never block the event loop and must tolerate failures quietly.

export interface GitInfo {
  branch: string | null;
  // Modified + untracked entries in the working tree.
  dirty: number;
  ahead: number;
  behind: number;
}

export type PrState = "open" | "merged" | "closed";
export type CheckState = "success" | "failure" | "pending";

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: PrState;
  draft: boolean;
  // Rolled-up CI status; null when the PR has no checks.
  checks: CheckState | null;
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, encoding: "utf-8", timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

// `git status --porcelain=v2 --branch` in one call: branch, ahead/behind and
// the working-tree entries.
export function parseGitStatus(text: string): GitInfo {
  const info: GitInfo = { branch: null, dirty: 0, ahead: 0, behind: 0 };
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      info.branch = head === "(detached)" ? "HEAD" : head;
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        info.ahead = Number(m[1]);
        info.behind = Number(m[2]);
      }
    } else if (!line.startsWith("#")) {
      info.dirty++;
    }
  }
  return info;
}

export async function gitStatus(cwd: string): Promise<GitInfo | null> {
  const out = await run("git", ["status", "--porcelain=v2", "--branch"], cwd, 4000);
  return out === null ? null : parseGitStatus(out);
}

export function gitBranch(cwd: string): Promise<string | null> {
  return gitStatus(cwd).then((s) => s?.branch ?? null);
}

// gh's statusCheckRollup is a list of check runs / status contexts; fold it.
export function parsePrJson(raw: unknown): PrInfo | null {
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d.url !== "string") return null;
  const stateRaw = String(d.state ?? "OPEN").toUpperCase();
  const state: PrState =
    stateRaw === "MERGED" ? "merged" : stateRaw === "CLOSED" ? "closed" : "open";
  let checks: CheckState | null = null;
  const rollup = d.statusCheckRollup as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(rollup) && rollup.length > 0) {
    checks = "success";
    for (const c of rollup) {
      const conclusion = String(c.conclusion ?? c.state ?? "").toUpperCase();
      const status = String(c.status ?? "").toUpperCase();
      if (
        [
          "FAILURE",
          "ERROR",
          "TIMED_OUT",
          "CANCELLED",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
        ].includes(conclusion)
      ) {
        checks = "failure";
        break;
      }
      const finished =
        status === "COMPLETED" || ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
      if (!finished) checks = "pending";
    }
  }
  return {
    number: Number(d.number ?? 0),
    url: d.url,
    title: String(d.title ?? ""),
    state,
    draft: !!d.isDraft,
    checks,
  };
}

export async function getPrInfo(cwd: string, branch: string | null): Promise<PrInfo | null> {
  if (!branch || branch === "main" || branch === "master" || branch === "HEAD") return null;
  const out = await run(
    "gh",
    ["pr", "view", branch, "--json", "number,url,title,state,isDraft,statusCheckRollup"],
    cwd,
    10000,
  );
  if (!out?.trim()) return null;
  try {
    return parsePrJson(JSON.parse(out));
  } catch {
    return null;
  }
}
