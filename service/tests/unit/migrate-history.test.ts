// scripts/migrate-history.ts, run as it is at the restart: histories out of
// the workspace files into history.db, the index built ahead.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { closeHistory, historyFile, historyIndexFile, loadAll } from "../../src/workspace/state";
import type { Message, WorkspaceState } from "../../src/workspace/workspace";

const root = path.resolve(__dirname, "../../..");
const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) {
    closeHistory(b);
    fs.rmSync(b, { recursive: true, force: true });
  }
});

const msg = (id: string, content: string, t: number): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp: t,
  status: "done",
});

// A data dir as the old build leaves it: messages inside the workspace files.
function oldDataDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-migrate-"));
  bases.push(base);
  const dir = path.join(base, ".agent-team", "cache", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  const write = (id: string, messages?: Message[]) => {
    const ws: WorkspaceState = {
      id,
      name: id,
      project: "p",
      hostId: "local",
      cwd: "/tmp",
      agents: [],
      createdAt: 1,
      ...(messages && { messages }),
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(ws));
  };
  const index = (ids: string[]) =>
    fs.writeFileSync(
      path.join(base, ".agent-team", "cache", "index.json"),
      JSON.stringify({ workspaceIds: ids }),
    );
  const raw = {
    ...msg("r1", "zebra with raw", 3),
    events: [{ kind: "text", content: "x", raw: 1 }],
  };
  write("w1", [msg("m1", "the zebra crossing", 1), raw as unknown as Message]);
  write("w2", [msg("m2", "giraffe", 2)]);
  write("w3");
  index(["w1", "w2", "w3"]);
  const read = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")) as WorkspaceState;
  return { base, dir, write, index, read };
}

function run(base: string, ...args: string[]) {
  const r = spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "scripts", "migrate-history.ts"), "--base", base, ...args],
    { encoding: "utf-8" },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

function rows(base: string, sql: string) {
  const db = new DatabaseSync(historyFile(base), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

describe("moving the histories into history.db", () => {
  it("stops before changing a workspace file when a history cannot be moved", async () => {
    const { base, write, read } = oldDataDir();
    write("w2", [{ id: "m9", content: "no kind" } as unknown as Message]);
    const r = run(base, "--finish", "--port", String(await freePort()));
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain("Stopped before any workspace file changed");
    expect(read("w1").messages).toHaveLength(2);
    expect(read("w2").messages).toHaveLength(1);
  });

  it("prepares ahead, catches up with the server stopped, and leaves the old files aside", async () => {
    const { base, dir, write, index, read } = oldDataDir();
    // The new build does not start on the old files.
    expect(() => loadAll(base)).toThrow("still holds its messages");

    // Ahead, with the old server running: the files stay as they are.
    const ahead = run(base);
    expect(ahead.status, ahead.out).toBe(0);
    expect(ahead.out).toContain("history.db: 2 histories, 3 messages; 2 written now, 0 deleted");
    expect(read("w1").messages).toHaveLength(2);
    expect(rows(base, "select session, id from messages order by session, seq")).toEqual([
      { session: "w1", id: "m1" },
      { session: "w1", id: "r1" },
      { session: "w2", id: "m2" },
    ]);
    expect(JSON.stringify(rows(base, "select body from messages"))).not.toContain('\\"raw\\":');
    const idx = new DatabaseSync(historyIndexFile(base), { readOnly: true });
    expect(idx.prepare("select count(*) as n from docs").get()).toEqual({ n: 3 });
    idx.close();

    // The old server goes on: a new message, a deleted workspace.
    write("w1", [msg("m1", "the zebra crossing", 1), msg("m3", "okapi", 4)]);
    index(["w1", "w3"]);
    fs.rmSync(path.join(dir, "w2.json"));

    const port = await freePort();
    const busy = net.createServer().listen(port, "127.0.0.1");
    await new Promise((r) => busy.once("listening", r));
    const refused = run(base, "--finish", "--port", String(port));
    busy.close();
    expect(refused.status).toBe(2);
    expect(refused.out).toContain(`A server is listening on port ${port}`);
    expect(read("w1").messages).toHaveLength(2);

    const done = run(base, "--finish", "--port", String(port));
    expect(done.status, done.out).toBe(0);
    expect(done.out).toContain("1 written now, 1 deleted");
    expect(done.out).toContain("Moved 1 histories");
    expect(read("w1")).not.toHaveProperty("messages");
    const kept = path.join(base, ".agent-team", "backup-v1", "w1.json");
    expect((JSON.parse(fs.readFileSync(kept, "utf-8")) as WorkspaceState).messages).toHaveLength(2);
    expect(rows(base, "select session, id from messages order by session, seq")).toEqual([
      { session: "w1", id: "m1" },
      { session: "w1", id: "m3" },
    ]);

    // The new build starts on it, and there is nothing left to move.
    const states = loadAll(base);
    expect(states.find((w) => w.id === "w1")!.messages!.map((m) => m.content)).toEqual([
      "the zebra crossing",
      "okapi",
    ]);
    closeHistory(base);
    const again = run(base, "--finish", "--port", String(port));
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain("No workspace file holds messages any more");
  });
});
