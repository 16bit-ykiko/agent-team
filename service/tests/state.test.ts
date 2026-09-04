import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendLog,
  deleteWorkspaceState,
  loadAll,
  loadWorkspaceMessages,
  saveIndex,
  saveWorkspace,
  stripLegacyRaw,
} from "../src/state";
import { Message, WorkspaceState } from "../src/task";

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

  it("rewrites the state file on load so the cleanup happens once", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    saveIndex(base, ["ws-1"]);
    const file = path.join(base, ".agent-team", "cache", "workspaces", "ws-1.json");
    expect(fs.readFileSync(file, "utf-8")).toContain('"raw"');

    const loaded = loadAll(base);
    expect(loaded).toHaveLength(1);
    expect(JSON.stringify(loaded[0])).not.toContain('"raw"');
    expect(fs.readFileSync(file, "utf-8")).not.toContain('"raw"');
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
    expect(loaded[0].messages).toHaveLength(1);
    expect(loadWorkspaceMessages(base, "ws-1")).toHaveLength(1);
  });

  it("deleting a workspace removes its state file and log directory", () => {
    const base = tmpBase();
    saveWorkspace(base, wsWithRaw());
    appendLog(base, "ws-1", { hello: 1 });
    const logDir = path.join(base, ".agent-team", "logs", "ws-1");
    expect(fs.existsSync(logDir)).toBe(true);
    deleteWorkspaceState(base, "ws-1");
    expect(fs.existsSync(logDir)).toBe(false);
    expect(loadWorkspaceMessages(base, "ws-1")).toEqual([]);
  });
});
