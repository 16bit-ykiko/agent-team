// The real Server in-process saving histories into history.db: what a save
// writes, the full compare before a history leaves memory, a restart's
// interrupted turn, and the sidebar's search over it. The Claude SDK is a
// fake that never yields, so no CLI is spawned.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import type { AgentState, Message, WorkspaceState } from "../../src/workspace/workspace";

vi.mock("../../src/server/quota", () => ({
  QuotaMonitor: class {
    entries = [];
    refreshIfStale() {}
    invalidate() {}
  },
}));

import { Server } from "../../src/server/server";
import { ClaudeSession } from "../../src/session/claude";
import { HistoryDb } from "../../src/workspace/history-db";
import { historyFile } from "../../src/workspace/state";

const ENV_KEYS = ["HOME", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let savedEnv: Record<string, string | undefined>;
const bases: string[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  ClaudeSession.sdk = {
    query: () => {
      let finish: (r: IteratorResult<unknown>) => void = () => {};
      const pending = new Promise<IteratorResult<unknown>>((r) => (finish = r));
      return {
        [Symbol.asyncIterator]: () => ({ next: () => pending }),
        close: () => finish({ value: undefined, done: true }),
        supportedCommands: () => Promise.resolve([]),
        stopTask: () => Promise.resolve(),
        getContextUsage: () => Promise.resolve(null),
        interrupt: () => Promise.resolve(),
      };
    },
    createSdkMcpServer: (o: unknown) => o,
    tool: (name: string) => ({ name }),
  } as unknown as typeof ClaudeSession.sdk;
});

afterEach(() => {
  ClaudeSession.sdk = null;
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

function agent(id: string, cwd: string): AgentState {
  return {
    id,
    name: "A",
    model: "claude-opus-5-5[1m]",
    avatar: "A",
    color: "#fff",
    isDefault: true,
    session: {
      sessionId: null,
      config: { cwd, backend: "claude", model: "claude-opus-5-5[1m]" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    },
  };
}

// Recent, or the sweep at start archives them.
const T0 = Date.now() - 60_000;
const msg = (
  id: string,
  content: string,
  timestamp: number,
  over: Partial<Message> = {},
): Message => ({
  id,
  kind: "agent",
  agentId: "a-1",
  content,
  timestamp: T0 + timestamp,
  status: "done",
  ...over,
});

// Workspaces as the server saves them: <id>.json, and the history in
// history.db.
function seed(workspaces: Array<{ state: WorkspaceState; messages: Message[] }>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-server-history-"));
  bases.push(base);
  const root = path.join(base, "repo");
  const web = path.join(base, "web");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(path.join(web, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(base, "config.toml"), "");
  process.env.HOME = path.join(base, "home");
  const dir = path.join(base, ".agent-team", "cache", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  const db = new HistoryDb(historyFile(base));
  for (const { state: s, messages } of workspaces) {
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify({ ...s, cwd: root }));
    db.save(s.id, messages, "all");
  }
  db.close();
  fs.writeFileSync(
    path.join(base, ".agent-team", "cache", "index.json"),
    JSON.stringify({ workspaceIds: workspaces.map((w) => w.state.id) }),
  );
  return { base, web, dir };
}

const ws = (id: string, messages: Message[], archivedAt: number | null = null) => ({
  state: {
    id,
    name: id,
    project: "repo",
    hostId: "local",
    cwd: "",
    agents: [agent("a-1", "")],
    createdAt: T0,
    archivedAt,
  } as WorkspaceState,
  messages,
});

async function start(base: string, web: string) {
  const port = await freePort();
  const server = new Server(port, base, web);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as never));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await until(() => frames.some((f) => f.type === "init"), "init");
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
  const search = async (query: string) => {
    const seen = frames.length;
    send({ type: "search", query });
    await until(
      () => frames.slice(seen).some((f) => f.type === "search_results" && f.query === query),
      `search ${query}`,
    );
    const r = frames.slice(seen).find((f) => f.type === "search_results" && f.query === query)!;
    return (r.hits as Array<{ workspaceId: string; messageId: string }>).map(
      (h) => `${h.workspaceId}/${h.messageId}`,
    );
  };
  const live = (id: string) =>
    (server as unknown as { workspaces: Map<string, { messages: Message[] }> }).workspaces.get(id)!;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ws.close();
    server.close();
  };
  return { server, frames, send, search, live, stop };
}

// history.db as it is on disk, through a connection of its own.
function rows(base: string, session: string): Array<Pick<Message, "id" | "status" | "content">> {
  const db = new DatabaseSync(historyFile(base), { readOnly: true });
  try {
    return (
      db.prepare("select body from messages where session = ? order by seq").all(session) as Array<{
        body: string;
      }>
    ).map((r) => {
      const m = JSON.parse(r.body) as Message;
      return { id: m.id, status: m.status, content: m.content };
    });
  } finally {
    db.close();
  }
}

describe("a real server saving histories", () => {
  it("saves a finished message an event changes later (a background task's end)", async () => {
    const { base, web } = seed([ws("ws-a", [msg("a1", "started a task", 1000)])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { live, stop } = await start(base, web);
    try {
      const w = live("ws-a") as unknown as {
        messages: Message[];
        streamed: (m: Message, e: { kind: string; content: string }) => void;
      };
      const done = w.messages[0];
      done.content = "started a task; it finished";
      w.streamed(done, { kind: "notice", content: "task done" });
      await until(
        () => rows(base, "ws-a")[0].content === "started a task; it finished",
        "the late change saved",
      );
    } finally {
      stop();
    }
  });

  it("the sidebar finds what was said in live and archived histories", async () => {
    const { base, web } = seed([
      ws("ws-a", [msg("u1", "the zeppelin bug again", 1000, { kind: "user", agentId: null })]),
      ws("ws-b", [msg("b1", "a narwhal in the archive", 900)], 5),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { search, stop } = await start(base, web);
    try {
      expect(await search("NARWHAL")).toEqual(["ws-b/b1"]);
      expect(await search("zeppelin")).toEqual(["ws-a/u1"]);
    } finally {
      stop();
    }
  });

  // What history.db holds when the server died mid-turn: the turn as last
  // saved, still streaming.
  function crashMidTurn(base: string, session: string, m: Message): void {
    const db = new DatabaseSync(historyFile(base));
    const body = JSON.stringify(m);
    const hash = createHash("sha1").update(body).digest("base64");
    const { seq } = db
      .prepare("select max(seq) + 1 as seq from messages where session = ?")
      .get(session) as { seq: number };
    db.prepare("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      session,
      m.id,
      seq,
      m.timestamp,
      m.kind,
      m.status,
      hash,
      body,
    );
    db.close();
  }

  async function restartedMidTurn() {
    const { base, web } = seed([
      ws("ws-a", [msg("u1", "hello", 1000, { kind: "user", agentId: null })]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    (await start(base, web)).stop();
    crashMidTurn(
      base,
      "ws-a",
      msg("a1", "half an answer about quokkas", 1001, { status: "streaming" }),
    );
    return { base, web };
  }

  it("writes a turn a restart cut short at once, naming only it", async () => {
    const { base, web } = await restartedMidTurn();
    const save = vi.spyOn(HistoryDb.prototype, "save");
    const { stop } = await start(base, web);
    try {
      expect(rows(base, "ws-a").find((m) => m.id === "a1")!.content).toBe(
        "half an answer about quokkas\n\n*\\[interrupted\\]*",
      );
      const calls = save.mock.calls.filter(([s]) => s === "ws-a");
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toBeInstanceOf(Set);
      expect([...(calls[0][2] as Set<string>)]).toEqual(["a1"]);
    } finally {
      stop();
    }
  });

  it("finds a turn a restart cut short without waiting for another save", async () => {
    const { base, web } = await restartedMidTurn();
    const { search, stop } = await start(base, web);
    try {
      expect(rows(base, "ws-a").find((m) => m.id === "a1")!.status).toBe("done");
      expect(await search("quokkas")).toEqual(["ws-a/a1"]);
    } finally {
      stop();
    }
  });

  it("writes only what was marked as it goes, and compares every message before archiving and on shutdown", async () => {
    const { base, web } = seed([
      ws("ws-a", [
        msg("u1", "first", 1000, { kind: "user", agentId: null }),
        msg("a1", "reply", 1001),
      ]),
      ws("ws-c", [msg("c1", "other", 1000)]),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const save = vi.spyOn(HistoryDb.prototype, "save");
    const { send, frames, live, stop } = await start(base, web);
    try {
      // Changed in memory by a path that did not mark it.
      live("ws-a").messages[0].content = "first, edited";
      live("ws-c").messages[0].content = "other, edited";
      send({ type: "clear_context", workspaceId: "ws-a", agentId: "a-1" });
      await until(
        () => rows(base, "ws-a").some((m) => m.content.includes("context cleared")),
        "the system message saved",
      );
      expect(rows(base, "ws-a")[0].content).toBe("first");

      save.mockClear();
      send({ type: "archive_workspace", workspaceId: "ws-a" });
      await until(
        () => frames.some((f) => f.type === "workspace_archived" && f.workspaceId === "ws-a"),
        "archived",
      );
      expect(save.mock.calls.filter(([s]) => s === "ws-a").map((c) => c[2])).toEqual(["all"]);
      expect(rows(base, "ws-a")[0].content).toBe("first, edited");
      expect(rows(base, "ws-c")[0].content).toBe("other");
    } finally {
      stop();
    }
    expect(rows(base, "ws-c")[0].content).toBe("other, edited");
  });

  it("an interrupted turn at shutdown is saved as such", async () => {
    const { base, web } = seed([ws("ws-a", [])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { send, frames, stop } = await start(base, web);
    try {
      send({ type: "send_message", workspaceId: "ws-a", content: "tell me about axolotls" });
      await until(
        () =>
          frames.some(
            (f) =>
              f.type === "new_message" &&
              (f.message as Message).kind === "agent" &&
              (f.message as Message).status === "streaming",
          ),
        "the turn started",
      );
    } finally {
      stop();
    }
    const saved = rows(base, "ws-a").filter((m) => m.content !== "tell me about axolotls");
    expect(saved.map((m) => m.status)).toEqual(["done"]);
    expect(saved[0].content).toContain("interrupted");
  });

  it("never saves an empty history over one it could not read", async () => {
    const { base, web } = seed([ws("ws-a", [msg("a1", "kept", 1000)])]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new DatabaseSync(historyFile(base));
    db.prepare("insert into messages values (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ws-a",
      "a2",
      99,
      2000,
      "agent",
      "done",
      "x",
      '{"id":"a2","cont',
    );
    db.close();
    const { stop } = await start(base, web);
    stop();
    expect(
      new DatabaseSync(historyFile(base), { readOnly: true })
        .prepare("select id from messages where session = 'ws-a' order by seq")
        .all(),
    ).toEqual([{ id: "a1" }, { id: "a2" }]);
  });
});
