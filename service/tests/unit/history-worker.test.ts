// The search index in its worker thread, as the server bundle runs it: the
// worker is built from history-worker.ts with the bundle's options, beside
// nothing else, and a HistoryService pointed at it.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { buildSync } from "esbuild";
import { HistoryDb } from "../../src/workspace/history-db";
import { HistoryService } from "../../src/workspace/history-service";
import type { Message } from "../../src/workspace/workspace";

let out: string;
let workerFile: string;
beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-worker-build-"));
  buildSync({
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    entryPoints: {
      "history-worker": path.resolve(__dirname, "../../src/workspace/history-worker.ts"),
    },
    outdir: out,
    logLevel: "silent",
  });
  workerFile = path.join(out, "history-worker.js");
});
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Internals = { workerFile: string; worker: Worker | null };

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-worker-"));
  const historyFile = path.join(base, "history.db");
  const db = new HistoryDb(historyFile);
  const threaded = new HistoryService(path.join(base, "index-worker.db"), historyFile);
  (threaded as unknown as Internals).workerFile = workerFile;
  const local = new HistoryService(path.join(base, "index-local.db"), historyFile);
  cleanups.push(
    () => fs.rmSync(base, { recursive: true, force: true }),
    () => db.close(),
    () => threaded.close(),
    () => local.close(),
  );
  const save = (session: string, messages: Message[]) => {
    db.save(session, messages, "all");
    threaded.changed();
    local.changed();
  };
  const worker = () => (threaded as unknown as Internals).worker;
  return { threaded, local, save, worker };
}

const msg = (
  id: string,
  content: string,
  timestamp: number,
  over: Partial<Message> = {},
): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp,
  status: "done",
  ...over,
});

const w1 = {
  id: "w1",
  name: "w",
  cwd: "/tmp",
  project: null,
  role: null,
  created_at: 1,
  last_active: 2,
  archived_at: null,
};

const history: Message[] = [
  msg("m1", "the zebra crossing", 1),
  msg("m2", "Found it.", 2, {
    events: [
      {
        kind: "tool_use",
        content: "**Bash** `ctest`",
        toolName: "Bash",
        toolUseId: "t1",
        toolResult: "ok 1\nFAILED zebra\nok 3",
      },
    ],
  }),
];

describe("the history index in its worker thread", () => {
  it("answers every kind of question as it does in-process, errors included", async () => {
    const { threaded, local, save, worker } = setup();
    save("w1", history);
    const search = { terms: ["zebra"], kinds: ["said", "tool_output"] as const, limit: 10 };
    const hits = await threaded.search({ ...search, kinds: [...search.kinds] });
    expect(worker()).not.toBeNull();
    expect(hits).toEqual(await local.search({ ...search, kinds: [...search.kinds] }));
    expect(hits.hits.map((h) => `${h.message} ${h.kind}`)).toEqual(["m2 tool_output", "m1 said"]);
    const entry = hits.hits[0].entry;
    expect(await threaded.read(entry, 2, 1)).toEqual(await local.read(entry, 2, 1));
    expect(await threaded.read(999, 1, 1)).toBeNull();
    expect(await threaded.entries("w1", ["m2"])).toEqual(await local.entries("w1", ["m2"]));
    expect(await threaded.sql("select count(*) as n from messages", [w1], 5)).toEqual({
      columns: ["n"],
      rows: [{ n: 2 }],
      truncated: false,
    });
    await expect(threaded.search({ terms: [], regex: "(", limit: 1 })).rejects.toThrow(
      "Invalid regular expression",
    );
    await expect(threaded.sql("drop table main.entries", [w1], 5)).rejects.toThrow("readonly");
    // Still answering after an error.
    expect((await threaded.search({ terms: ["crossing"], limit: 1 })).hits).toHaveLength(1);
  });

  it("hears of changes once a second, however many there are", async () => {
    const { threaded, save } = setup();
    save("w1", history);
    await threaded.search({ terms: ["zebra"], limit: 1 });
    const post = vi.spyOn(Worker.prototype, "postMessage");
    for (let i = 0; i < 5; i++) save("w1", [...history, msg(`n${i}`, `giraffe ${i}`, 10 + i)]);
    expect(post).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 1200));
    expect(post.mock.calls.filter(([m]) => (m as { changed?: true }).changed)).toHaveLength(1);
    const found = await threaded.search({ terms: ["giraffe"], limit: 10 });
    expect(found.hits.map((h) => h.message)).toEqual(["n4"]);
  });

  it("finds what was just saved, or says it is not searchable yet", async () => {
    const { threaded, save } = setup();
    save("w1", history);
    await threaded.search({ terms: ["zebra"], limit: 1 });
    save("w1", [...history, msg("m3", "a new okapi", 3)]);
    const r = await threaded.search({ terms: ["okapi"], limit: 10 });
    expect(r.hits.length > 0 || r.pending > 0).toBe(true);
  });

  it("kills an SQL query that runs too long, and answers the next", async () => {
    const { threaded, save, worker } = setup();
    save("w1", history);
    await threaded.search({ terms: ["zebra"], limit: 1 });
    const first = worker()!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = Date.now();
    const slow = threaded.sql(
      "with recursive c(x) as (select 1 union all select x + 1 from c where x < 300000000) select count(*) as n from c",
      [w1],
      1,
    );
    const failed = expect(slow).rejects.toThrow("took longer than 20 s");
    // Until its process is inside the query.
    for (const t = Date.now(); Date.now() - t < 1000;) {
      await new Promise((r) => setImmediate(r));
    }
    vi.advanceTimersByTime(20_000);
    await failed;
    vi.useRealTimers();
    // Killed, not left to finish (that takes minutes).
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await threaded.sql("select 1 as n", [w1], 1)).rows).toEqual([{ n: 1 }]);
    expect(worker()).toBe(first);
  }, 30_000);

  it("fails what a worker that stopped was asked, and starts a new one for the next question", async () => {
    const { threaded, save, worker } = setup();
    save("w1", history);
    await threaded.search({ terms: ["zebra"], limit: 1 });
    const first = worker()!;
    const pending = threaded.search({ terms: ["zebra"], limit: 1 });
    first.emit("exit", 1);
    await expect(pending).rejects.toThrow("The history index stopped; ask again");
    await first.terminate();
    expect((await threaded.search({ terms: ["zebra"], limit: 5 })).hits).toHaveLength(2);
    expect(worker()).not.toBe(first);
  });

  it("fails what is pending when closed", async () => {
    const { threaded, save } = setup();
    save("w1", history);
    await threaded.search({ terms: ["zebra"], limit: 1 });
    const pending = threaded.search({ terms: ["zebra"], limit: 1 });
    const failed = expect(pending).rejects.toThrow("The history index was closed");
    await threaded.close();
    await failed;
  });
});
