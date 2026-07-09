import { execFile } from "child_process";

// Branch/PR lookups run on a 2s timer across every workspace, so they must
// never block the event loop (the old execSync version stalled the server)
// and must tolerate failures quietly.

export function gitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, encoding: "utf-8", timeout: 2000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

export function getPrInfo(
  cwd: string,
  branch: string | null,
): Promise<{ url: string; title: string } | null> {
  if (!branch || branch === "main" || branch === "master" || branch === "HEAD") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", branch, "--json", "url,title"],
      { cwd, encoding: "utf-8", timeout: 10000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          resolve(data.url ? { url: data.url, title: data.title || "" } : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}
