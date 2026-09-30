import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendLog,
  closeHistory,
  deleteWorkspaceState,
  historyFile,
  historyOf,
  isLoggedEvent,
  loadAll,
  loadWorkspaceMessages,
  saveIndex,
  saveWorkspace,
  stripLegacyRaw,
} from "../../src/workspace/state";
import { Message, WorkspaceState } from "../../src/workspace/workspace";

const bases: string[] = [];
function tmpBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-state-"));
  bases.push(base);
  return base;
}
afterEach(() => {
  for (const base of bases.splice(0)) {
    closeHistory(base);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A row of history.db changed behind the server's back.
function setBody(base: string, id: string, body: string): void {
  const db = new DatabaseSync(historyFile(base));
  db.prepare("update messages set body = ? where session = ? and id = ?").run(body, "ws-1", id);
  db.close();
}

function wsWithRaw(): WorkspaceState {
  return {
    id: "ws-1",
    name: "t",
    project: "p",
    hostId: "local",
    cwd: "/tmp",
    agents: [],
    createdAt: 1,
    messages: [
      {
        id: "m1",
        kind: "agent",
        agentId: "a",
        content: "x",
        timestamp: 1,
        status: "done",
        events: [
          { kind: "thinking", content: "t", raw: { huge: "payload" } },
          {
            kind: "subagent_start",
            content: "",
            raw: { more: 1 },
            subagent: {
              taskId: "task",
              description: "",
              events: [{ kind: "tool_use", content: "Read", raw: { nested: true } }],
            },
          },
        ] as unknown as Message["events"],
      },
    ],
  };
}

describe("legacy raw stripping", () => {
  it("removes raw from top-level and nested subagent events", () => {
    const ws = wsWithRaw();
    expect(stripLegacyRaw(ws)).toBe(3);
    const events = ws.messages![0].events as unknown as Array<Record<string, unknown>>;
    expect(events.every((e) => !("raw" in e))).toBe(true);
    const inner = (events[1].subagent as { events: Array<Record<string, unknown>> }).events;
    expect("raw" in inner[0]).toBe(false);
    expect(stripLegacyRaw(ws)).toBe(0);
  });

  it("moves a history saved inside the state file into history.db, once, without the legacy raw", () => {
    const base = tmpBase();
    const dir = path.join(base, ".agent-team", "cache", "workspaces");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ws-1.json");
    fs.writeFileSync(file, JSON.stringify(wsWithRaw()));
    saveIndex(base, ["ws-1"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const loaded = loadAll(base);
    expect(log).toHaveBeenCalledWith("Moved 1 histories into history.db");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages).toHaveLength(1);
    expect(JSON.stringify(loaded[0])).not.toContain('"raw"');
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).not.toHaveProperty("messages");
    const stored = historyOf(base).load("ws-1");
    expect(stored).toMatchObject([{ id: "m1", content: "x" }]);
    expect(JSON.stringify(stored)).not.toContain('"raw"');
    // The file as it was, kept aside.
    const kept = path.join(base, ".agent-team", "backup-v1", "ws-1.json");
    expect((JSON.parse(fs.readFileSync(kept, "utf-8")) as WorkspaceState).messages).toHaveLength(1);
    // Nothing left to move the second time.
    log.mockClear();
    expect(loadAll(base)[0].messages).toMatchObject([{ id: "m1", content: "x" }]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Moved"));
    log.mockRestore();
  });

  it("keeps any text as it was", () => {
    const base = tmpBase();
    const ws = wsWithRaw();
    ws.messages![0].content = 'line one\nline "two"\n\n中文';
    saveWorkspace(base, ws);
    closeHistory(base);
    expect(loadWorkspaceMessages(base, "ws-1")[0].content).toBe('line one\nline "two"\n\n中文');
  });
});

describe("saving a history", () => {
  const msg = (id: string, content: string): Message => ({
    id,
    kind: "user",
    agentId: null,
    content,
    timestamp: 1,
    status: "done",
  });
  const stored = (base: string) => {
    closeHistory(base);
    return historyOf(base)
      .load("ws-1")
      .map((m) => `${m.id}:${m.content}`);
  };

  it("writes the messages named as changed, the new ones, and drops the removed", () => {
    const base = tmpBase();
    const messages = [msg("a", "one"), msg("b", "two")];
    const ws = { ...wsWithRaw(), messages };
    expect(saveWorkspace(base, ws)).toBe(true);
    messages[0].content = "one, edited";
    messages[1].content = "two, edited";
    messages.push(msg("c", "three"));
    expect(saveWorkspace(base, ws, new Set(["b"]))).toBe(true);
    expect(stored(base)).toEqual(["a:one", "b:two, edited", "c:three"]);
    // Nothing named, nothing new: nothing written.
    expect(saveWorkspace(base, ws, new Set())).toBe(false);
    // Compared one by one, what was missed is written too.
    expect(saveWorkspace(base, ws, "all")).toBe(true);
    expect(saveWorkspace(base, ws, "all")).toBe(false);
    messages.splice(1, 1);
    messages.push(msg("d", "four"));
    expect(saveWorkspace(base, ws, new Set())).toBe(true);
    expect(stored(base)).toEqual(["a:one, edited", "c:three", "d:four"]);
  });
});

describe("unloaded workspaces", () => {
  it("keeps the on-disk history when a state without messages is saved", () => {
    const base = tmpBase();
    const ws = wsWithRaw();
    saveWorkspace(base, ws);
    saveIndex(base, ["ws-1"]);

    saveWorkspace(base, { ...ws, messages: undefined, archivedAt: 42 });
    const loaded = loadAll(base);
    expect(loaded[0].archivedAt).toBe(42);
    expect(loaded[0].messages).toBeUndefined();
    expect(loadWorkspaceMessages(base, "ws-1")).toHaveLength(1);
  });

  it("deleting a workspace removes its files and log directory", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    appendLog(base, "ws-1", { hello: 1 });
    const logDir = path.join(base, ".agent-team", "logs", "ws-1");
    expect(fs.existsSync(logDir)).toBe(true);
    deleteWorkspaceState(base, "ws-1");
    expect(fs.existsSync(logDir)).toBe(false);
    expect(loadWorkspaceMessages(base, "ws-1")).toEqual([]);
    expect(fs.readdirSync(path.join(base, ".agent-team", "cache", "workspaces"))).toEqual([]);
    closeHistory(base);
    expect(loadWorkspaceMessages(base, "ws-1")).toEqual([]);
  });

  it("saving an unloaded workspace never touches its history, even one it could not read", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    setBody(base, "m1", '{"id":"m1","cont');
    saveWorkspace(base, { ...wsWithRaw(), messages: undefined, archivedAt: 1 });
    const db = new DatabaseSync(historyFile(base));
    expect(db.prepare("select body from messages").get()).toEqual({ body: '{"id":"m1","cont' });
    db.close();
  });

  it("state files are private to the user", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    const file = path.join(base, ".agent-team", "cache", "workspaces", "ws-1.json");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    for (const f of [historyFile(base), `${historyFile(base)}-wal`]) {
      expect(fs.statSync(f).mode & 0o077).toBe(0);
    }
  });

  it("an unreadable history is an error, not an empty one", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    setBody(base, "m1", '{"id":"m1","cont');
    expect(() => loadWorkspaceMessages(base, "ws-1")).toThrow();
    expect(loadWorkspaceMessages(base, "ws-2")).toEqual([]);
  });

  it("loading scrubs account tokens older builds saved, and makes the file private", () => {
    const base = tmpBase();
    const dir = path.join(base, ".agent-team", "cache", "workspaces");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ws-1.json");
    const ws = wsWithRaw();
    ws.agents = [
      {
        id: "a",
        name: "A",
        model: "m",
        avatar: "",
        color: "",
        isDefault: true,
        session: {
          sessionId: null,
          config: { cwd: "/tmp", providerEnv: { ANTHROPIC_AUTH_TOKEN: "sk-old" } },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns: 0,
            duration_ms: 0,
          },
        },
      },
    ];
    fs.writeFileSync(file, JSON.stringify(ws), { mode: 0o664 });
    fs.chmodSync(file, 0o664);
    saveIndex(base, ["ws-1"]);
    loadAll(base);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("sk-old");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe("stream log", () => {
  it("keeps a thinking block's start and end markers, not its fragments", () => {
    expect(isLoggedEvent({ kind: "thinking_delta", content: "" })).toBe(true);
    expect(isLoggedEvent({ kind: "thinking_delta", content: "", durationMs: 900 })).toBe(true);
    expect(isLoggedEvent({ kind: "thinking_delta", content: "Hm" })).toBe(false);
    expect(isLoggedEvent({ kind: "thinking", content: "Hm" })).toBe(true);
  });
});
