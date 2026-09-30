import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendLog,
  deleteWorkspaceState,
  historyPath,
  isLoggedEvent,
  loadAll,
  loadWorkspaceMessages,
  saveIndex,
  saveWorkspace,
  stripLegacyRaw,
  textFileOf,
} from "../../src/workspace/state";
import { Message, WorkspaceState } from "../../src/workspace/workspace";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-state-"));
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

  it("moves a history saved inside the state file to its own, once, without the legacy raw", () => {
    const base = tmpBase();
    const dir = path.join(base, ".agent-team", "cache", "workspaces");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ws-1.json");
    fs.writeFileSync(file, JSON.stringify(wsWithRaw()));
    saveIndex(base, ["ws-1"]);

    const loaded = loadAll(base);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages).toHaveLength(1);
    expect(JSON.stringify(loaded[0])).not.toContain('"raw"');
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).not.toHaveProperty("messages");
    const lines = fs.readFileSync(path.join(dir, "ws-1.jsonl"), "utf-8").split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: "m1", content: "x" });
    expect(lines[0]).not.toContain('"raw"');
    // The file as it was, kept aside.
    const kept = path.join(base, ".agent-team", "backup-v1", "ws-1.json");
    expect((JSON.parse(fs.readFileSync(kept, "utf-8")) as WorkspaceState).messages).toHaveLength(1);
    // Nothing left to move the second time.
    const before = fs.statSync(path.join(dir, "ws-1.jsonl")).mtimeMs;
    loadAll(base);
    expect(fs.statSync(path.join(dir, "ws-1.jsonl")).mtimeMs).toBe(before);
  });

  it("keeps one message per line whatever its text holds", () => {
    const base = tmpBase();
    const ws = wsWithRaw();
    ws.messages![0].content = 'line one\nline "two"\n\n中文';
    saveWorkspace(base, ws);
    const text = fs.readFileSync(
      path.join(base, ".agent-team", "cache", "workspaces", "ws-1.jsonl"),
      "utf-8",
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(loadWorkspaceMessages(base, "ws-1")[0].content).toBe('line one\nline "two"\n\n中文');
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

  it("keeps what was said beside the history, without the tools", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    const text = fs.readFileSync(textFileOf(historyPath(base, "ws-1")), "utf-8");
    expect(text).toBe(
      `${JSON.stringify({ id: "m1", kind: "agent", content: "x", timestamp: 1 })}\n`,
    );
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
  });

  it("saving an unloaded workspace never touches its history, even one it could not read", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    const file = path.join(base, ".agent-team", "cache", "workspaces", "ws-1.jsonl");
    const truncated = fs.readFileSync(file, "utf-8").slice(0, 40);
    fs.writeFileSync(file, truncated);
    saveWorkspace(base, { ...wsWithRaw(), messages: undefined, archivedAt: 1 });
    expect(fs.readFileSync(file, "utf-8")).toBe(truncated);
  });

  it("state files are private to the user", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    const file = path.join(base, ".agent-team", "cache", "workspaces", "ws-1.json");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("an unreadable history is an error, not an empty one", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    const file = path.join(base, ".agent-team", "cache", "workspaces", "ws-1.jsonl");
    fs.chmodSync(file, 0o000);
    expect(() => loadWorkspaceMessages(base, "ws-1")).toThrow();
    fs.chmodSync(file, 0o600);
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
