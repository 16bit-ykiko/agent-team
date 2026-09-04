import { describe, it, expect } from "vitest";
import {
  groupWorkspaces,
  isGroupExpanded,
  STALE_MS,
  archivedWorkspaces,
  isArchived,
} from "../src/groups";
import { Workspace, Message, StreamEvent } from "../src/useServer";

const NOW = 1_800_000_000_000;

function ws(id: string, cwd: string, lastMessageAt: number, busy = false): Workspace {
  return {
    id,
    name: id,
    project: cwd.split("/").pop() ?? "",
    hostId: "local",
    cwd,
    gitBranch: null,
    prUrl: null,
    prTitle: null,
    agents: busy
      ? [{ id: "a", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true, busy }]
      : [],
    messages: [],
    createdAt: lastMessageAt - 1000,
    lastMessageAt,
  };
}

describe("groupWorkspaces", () => {
  it("groups by cwd and sorts groups and members by recency", () => {
    const groups = groupWorkspaces([
      ws("old-a", "/repo/a", NOW - 10 * 86_400_000),
      ws("new-b", "/repo/b", NOW - 1000),
      ws("new-a", "/repo/a", NOW - 2000),
    ]);
    // /repo/b's newest activity (NOW-1000) beats /repo/a's (NOW-2000).
    expect(groups.map((g) => g.key)).toEqual(["/repo/b", "/repo/a"]);
    expect(groups[1].workspaces.map((w) => w.id)).toEqual(["new-a", "old-a"]);
    expect(groups[1].label).toBe("a");
    expect(groups[1].lastActive).toBe(NOW - 2000);
  });

  it("marks groups with busy agents as running", () => {
    const groups = groupWorkspaces([
      ws("idle", "/repo/a", NOW),
      ws("busy", "/repo/a", NOW - 500, true),
    ]);
    expect(groups[0].running).toBe(true);
  });
});

describe("isGroupExpanded", () => {
  const fresh = groupWorkspaces([ws("f", "/repo/fresh", NOW - 1000)])[0];
  const stale = groupWorkspaces([ws("s", "/repo/stale", NOW - STALE_MS - 1)])[0];
  const staleRunning = groupWorkspaces([ws("r", "/repo/run", NOW - STALE_MS - 1, true)])[0];

  it("expands recent groups and collapses stale ones by default", () => {
    expect(isGroupExpanded(fresh, {}, NOW)).toBe(true);
    expect(isGroupExpanded(stale, {}, NOW)).toBe(false);
  });

  it("keeps a stale group expanded while something is running in it", () => {
    expect(isGroupExpanded(staleRunning, {}, NOW)).toBe(true);
  });

  it("lets explicit user toggles override the defaults", () => {
    expect(isGroupExpanded(fresh, { "/repo/fresh": false }, NOW)).toBe(false);
    expect(isGroupExpanded(stale, { "/repo/stale": true }, NOW)).toBe(true);
  });

  it("expands a stale group holding the active workspace, unless collapsed by hand", () => {
    expect(isGroupExpanded(stale, {}, NOW, true)).toBe(true);
    // The active group must still be collapsible — explicit toggle wins.
    expect(isGroupExpanded(fresh, { "/repo/fresh": false }, NOW, true)).toBe(false);
  });
});

describe("running state includes background subagents", () => {
  it("marks a group running when a message has a live subagent, even with idle agents", () => {
    const w = ws("bg", "/repo/bg", NOW - 1000);
    w.messages = [
      {
        id: "m1",
        kind: "agent",
        agentId: "a",
        content: "",
        timestamp: NOW - 1000,
        status: "done",
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: { taskId: "t", description: "", status: "running" },
          } as StreamEvent,
        ],
      } as Message,
    ];
    const groups = groupWorkspaces([w]);
    expect(groups[0].running).toBe(true);
    // Running keeps even a stale group expanded.
    expect(isGroupExpanded({ ...groups[0], lastActive: NOW - STALE_MS - 1 }, {}, NOW)).toBe(true);
  });
});

describe("archived workspaces", () => {
  it("keeps archived workspaces out of the folder groups", () => {
    const live = ws("live", "/repo/a", NOW - 1000);
    const old = { ...ws("old", "/repo/a", NOW - 20 * 86_400_000), archivedAt: NOW - 1000 };
    const groups = groupWorkspaces([live, old]);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspaces.map((w) => w.id)).toEqual(["live"]);
    expect(isArchived(old)).toBe(true);
    expect(isArchived(live)).toBe(false);
  });

  it("lists archived workspaces newest first, and drops the group when all are archived", () => {
    const a = { ...ws("a", "/repo/x", NOW - 5000), archivedAt: NOW };
    const b = { ...ws("b", "/repo/y", NOW - 1000), archivedAt: NOW };
    expect(archivedWorkspaces([a, b]).map((w) => w.id)).toEqual(["b", "a"]);
    expect(groupWorkspaces([a, b])).toEqual([]);
  });
});
