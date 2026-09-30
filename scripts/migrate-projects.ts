// Moves a panel to projects, after the server has put every workspace in
// its folder's project (it does on start): the sessions from before their
// project are archived (their history stays, for the leads to search), and
// each folder given has a live project with its lead; the other projects
// stay archived. It asks the running server over its WebSocket, so the
// server's own logic does the work and nothing on disk is edited behind its
// back. A copy of the history (.agent-team/cache) is made first. A busy
// session is left as it is: run the script again later; sessions made
// since the projects are never touched.
//
// With --archive-others (the first run), the projects of folders not given
// are archived; later runs leave projects made since then alone.
//
//   npm run migrate:projects -- --base . --port 9800 --archive-others --dry-run ~/workspace/clice ~/workspace/kotatsu
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync, backup as copyDatabase } from "node:sqlite";
import WebSocket from "ws";
import { loadConfig } from "../service/src/config/config";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const option = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const dryRun = option("--dry-run");
const archiveOthers = option("--archive-others");
// npm runs scripts from the package root; relative paths are the caller's.
const cwd = process.env.INIT_CWD ?? process.cwd();
const base = path.resolve(cwd, flag("--base") ?? ".");
const port = Number(flag("--port") ?? 9800);
const folders = args.map((a) => path.resolve(cwd, a.replace(/^~(?=\/|$)/, os.homedir())));
if (folders.length === 0) {
  throw new Error(
    "usage: npm run migrate:projects -- [--base dir] [--port n] [--dry-run] <folder>...",
  );
}
for (const f of folders) {
  if (!fs.statSync(f, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Not a folder: ${f}`);
}

interface Info {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  archivedAt?: number | null;
  projectLink?: { projectId: string; role: string };
}
interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  archivedAt?: number | null;
}

async function login(): Promise<string> {
  const auth = loadConfig(base).auth;
  if (!auth) return "";
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: auth.username, password: auth.password }),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`Login refused (${res.status})`);
  return cookie;
}

const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Cookie: await login() } });
const frames: Array<Record<string, unknown>> = [];
const waiters: Array<() => void> = [];
socket.on("message", (m: Buffer) => {
  frames.push(JSON.parse(m.toString()) as Record<string, unknown>);
  for (const w of waiters.splice(0)) w();
});
// The first frame, after `from`, that `match` accepts; null after `ms`.
async function next(
  from: number,
  match: (f: Record<string, unknown>) => boolean,
  ms = 10_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = frames.slice(from).find(match);
    if (hit) return hit;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((r) => {
      waiters.push(r);
      setTimeout(r, left);
    });
  }
}

const init = await next(0, (f) => f.type === "init");
if (!init) throw new Error("No answer from the server");
const workspaces = init.workspaces as Info[];
const projects = (init.projects as ProjectInfo[] | undefined) ?? [];

const projectOf = (w: Info) => projects.find((p) => p.id === w.projectLink?.projectId);
const unlinked = workspaces.filter((w) => !w.projectLink);
if (unlinked.length) {
  throw new Error(`${unlinked.length} workspaces have no project: is the server up to date?`);
}
const toArchive = workspaces.filter(
  (w) =>
    !w.archivedAt && w.projectLink?.role !== "lead" && w.createdAt < (projectOf(w)?.createdAt ?? 0),
);
const toCreate = folders.filter((f) => !projects.some((p) => p.root === f));
const toRevive = projects.filter((p) => p.archivedAt && folders.includes(p.root));
const toShelve = archiveOthers
  ? projects.filter((p) => !p.archivedAt && !folders.includes(p.root))
  : [];
console.log(`${toArchive.length} sessions from before their project to archive:`);
for (const w of toArchive) console.log(`  ${w.id}  ${w.name}  (${w.cwd})`);
console.log(`${toCreate.length} projects to create, ${toRevive.length} to bring back:`);
for (const f of toCreate) console.log(`  new: ${path.basename(f)}  (${f})`);
for (const p of toRevive) console.log(`  back: ${p.name}  (${p.root})`);
console.log(`${toShelve.length} other projects to archive:`);
for (const p of toShelve) console.log(`  ${p.name}  (${p.root})`);

if (dryRun) {
  socket.close();
  process.exit(0);
}

const cache = path.join(base, ".agent-team", "cache");
const backup = path.join(
  base,
  ".agent-team",
  `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
// history.db is being written: SQLite copies it whole; the search index is
// derived from it and left out.
const live = /^history(-index)?\.db(-wal|-shm)?$/;
fs.cpSync(cache, path.join(backup, "cache"), {
  recursive: true,
  filter: (src) => !live.test(path.basename(src)),
});
const history = new DatabaseSync(path.join(cache, "history.db"), { readOnly: true });
await copyDatabase(history, path.join(backup, "cache", "history.db"));
history.close();
fs.chmodSync(path.join(backup, "cache", "history.db"), 0o600);
console.log(`history copied to ${backup}`);

const busy: Info[] = [];
for (const w of toArchive) {
  const from = frames.length;
  socket.send(JSON.stringify({ type: "archive_workspace", workspaceId: w.id }));
  const reply = await next(
    from,
    (f) =>
      (f.type === "workspace_archived" && f.workspaceId === w.id) ||
      (f.type === "error" && f.message === "Workspace is still busy"),
  );
  if (reply?.type !== "workspace_archived") busy.push(w);
}
const failed: string[] = [];
for (const [list, archived] of [
  [toRevive, false],
  [toShelve, true],
] as const) {
  for (const p of list) {
    socket.send(JSON.stringify({ type: "archive_project", projectId: p.id, archived }));
  }
}
for (const folder of toCreate) {
  const from = frames.length;
  socket.send(
    JSON.stringify({ type: "create_project", name: path.basename(folder), path: folder }),
  );
  const reply = await next(
    from,
    (f) =>
      (f.type === "project_updated" && (f.project as ProjectInfo | undefined)?.root === folder) ||
      f.type === "error",
  );
  if (reply?.type !== "project_updated") {
    failed.push(`${folder}: ${reply ? String(reply.message) : "no answer"}`);
  }
}
socket.close();

console.log(`archived ${toArchive.length - busy.length} of ${toArchive.length}`);
for (const w of busy) console.log(`  still busy, left live: ${w.name} (${w.id})`);
console.log(
  `created ${toCreate.length - failed.length} of ${toCreate.length} projects, brought back ${toRevive.length}, archived ${toShelve.length}`,
);
for (const f of failed) console.log(`  failed: ${f}`);
