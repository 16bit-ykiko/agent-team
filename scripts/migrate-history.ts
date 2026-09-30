// One-time move of the histories into history.db, with its search index
// built ahead, so the server that reads them starts with both ready. Delete
// once no data dir holds messages inside its workspace files.
//
// Before the restart, with the old server still running (it replaces its
// workspace files whole, so each is read as it was at one moment):
//
//   npm run migrate:history -- --base .
//
// copies every history into history.db (a later run only what changed since),
// builds the index, and checks both against the files. At the restart, with
// the server stopped (scripts/restart-migrating-history.sh):
//
//   npm run migrate:history -- --base . --finish
//
// catches up once more, then keeps each old file under .agent-team/backup-v1/
// and rewrites it without its messages. The new server refuses to start while
// a workspace file still holds messages. Exit status 2: no workspace file was
// changed (the old build still runs on them).
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex } from "../service/src/workspace/history-index";
import {
  closeHistory,
  historyFile,
  historyIndexFile,
  historyOf,
} from "../service/src/workspace/state";
import type { Message, WorkspaceState } from "../service/src/workspace/workspace";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const finish = args.includes("--finish");
// npm runs scripts from the package root; relative paths are the caller's.
const cwd = process.env.INIT_CWD ?? process.cwd();
const base = path.resolve(cwd, flag("--base") ?? ".");
const port = Number(flag("--port") ?? 9800);
const cache = path.join(base, ".agent-team", "cache");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// Older builds stored the full SDK message on every event as `raw`.
function stripLegacyRaw(messages: Message[]): void {
  const strip = (events: unknown[] | undefined) => {
    for (const ev of events ?? []) {
      const e = ev as Record<string, unknown>;
      delete e.raw;
      const sub = e.subagent as { events?: unknown[] } | undefined;
      if (sub?.events) strip(sub.events);
    }
  };
  for (const m of messages) strip(m.events);
}

function listening(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(p, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

if (finish && (await listening(port))) fail(`A server is listening on port ${port}: stop it first`);

const ids = (
  JSON.parse(fs.readFileSync(path.join(cache, "index.json"), "utf-8")) as {
    workspaceIds: string[];
  }
).workspaceIds;
const fileOf = (id: string) => path.join(cache, "workspaces", `${id}.json`);

// Up to the files' rewrite, any failure leaves them as they were: status 2.
process.on("uncaughtException", (e) =>
  fail(`Stopped before any workspace file changed: ${e.stack ?? String(e)}`),
);

// Every history into history.db, checked as it is read back.
const history = historyOf(base);
const inline: string[] = [];
let messages = 0;
let written = 0;
for (const [n, id] of ids.entries()) {
  if (n % 20 === 0) console.log(`history.db: ${n}/${ids.length} workspaces`);
  if (!fs.existsSync(fileOf(id))) continue;
  const ws = JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as WorkspaceState;
  if (!ws.messages) continue;
  stripLegacyRaw(ws.messages);
  if (history.save(id, ws.messages, "all")) written++;
  if (JSON.stringify(history.load(id)) !== JSON.stringify(ws.messages)) {
    fail(`${id}: history.db does not hold what ${fileOf(id)} does`);
  }
  inline.push(id);
  messages += ws.messages.length;
}
// Workspaces deleted since an earlier run.
const listed = new Set(ids);
const reader = new DatabaseSync(historyFile(base), { readOnly: true });
const gone = (
  reader.prepare("select distinct session from messages").all() as Array<{
    session: string;
  }>
)
  .map((r) => r.session)
  .filter((s) => !listed.has(s));
reader.close();
for (const s of gone) history.delete(s);
console.log(
  `history.db: ${inline.length} histories, ${messages} messages; ${written} written now, ${gone.length} deleted`,
);

// The index, complete.
const started = Date.now();
const index = new HistoryIndex(historyIndexFile(base), historyFile(base));
while (!index.sync(10_000)) console.log(`index: ${index.pending} messages to go`);
const check = new DatabaseSync(historyIndexFile(base), { readOnly: true });
check.exec(`attach database '${historyFile(base).replace(/'/g, "''")}' as history`);
const { missing } = check
  .prepare(
    `select count(*) as missing from history.messages m
     where m.status not in ('streaming', 'queued') and not exists
       (select 1 from docs d where d.session = m.session and d.message = m.id and d.hash = m.hash)`,
  )
  .get() as { missing: number };
const { entries } = check.prepare("select count(*) as entries from entries").get() as {
  entries: number;
};
check.close();
if (missing) fail(`The index misses ${missing} messages`);
const t = performance.now();
const probe = index.search({ terms: ["error"], limit: 20 });
console.log(
  `index: ${entries} entries, complete in ${Math.round((Date.now() - started) / 1000)} s; a search: ${probe.hits.length} hits in ${Math.round(performance.now() - t)} ms`,
);
index.close();

if (finish && inline.length) {
  // On disk for good before a file loses its messages.
  history.checkpoint();
  process.removeAllListeners("uncaughtException");
  // Every old file kept first, then each rewritten: stopped halfway, every
  // history is still in its file or its backup, and in history.db.
  const backup = path.join(base, ".agent-team", "backup-v1");
  fs.mkdirSync(backup, { recursive: true });
  for (const id of inline) {
    let kept = path.join(backup, `${id}.json`);
    if (fs.existsSync(kept) && fs.statSync(kept).ino !== fs.statSync(fileOf(id)).ino) {
      kept = path.join(backup, `${id}.${Date.now()}.json`);
    }
    if (!fs.existsSync(kept)) fs.linkSync(fileOf(id), kept);
  }
  for (const id of inline) {
    const { messages: _messages, ...meta } = JSON.parse(
      fs.readFileSync(fileOf(id), "utf-8"),
    ) as WorkspaceState;
    const tmp = `${fileOf(id)}.migrate.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(tmp, fileOf(id));
  }
  console.log(`Moved ${inline.length} histories; the files as they were are in ${backup}`);
} else if (finish) {
  console.log("No workspace file holds messages any more");
}
closeHistory(base);
