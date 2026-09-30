// The history in history.db, its search index, and what a workspace marks
// as changed for the next save.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { entriesOf } from "../../src/workspace/history-index";
import { HistoryService, sidebarHits } from "../../src/workspace/history-service";
import { closeHistory, historyFile, historyIndexFile, historyOf } from "../../src/workspace/state";
import { Workspace, type Message, type WorkspaceState } from "../../src/workspace/workspace";
import { HostRegistry } from "../../src/session/host";
import type { StreamEvent } from "../../src/session/claude";
import { FakeHost } from "./fakes";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-history-"));
  const history = new HistoryService(historyIndexFile(base), historyFile(base));
  cleanups.push(
    () => history.close(),
    () => closeHistory(base),
    () => fs.rmSync(base, { recursive: true, force: true }),
  );
  const save = (session: string, messages: Message[]) => {
    historyOf(base).save(session, messages, "all");
    history.changed();
  };
  return { base, history, save };
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

describe("the sidebar's search", () => {
  const sessions = [
    { id: "w1", name: "clice" },
    { id: "w2", name: "agent-team" },
  ];
  function withHistories() {
    const s = setup();
    s.save("w1", [
      msg("m1", "Fixed the parser crash in dependency_graph.cpp", 100),
      msg("m2", "The lexer needs a rewrite", 200),
      msg("s1", "crash system", 999, { kind: "system" }),
    ]);
    s.save("w2", [
      msg("m3", "Subagent rendering crash reproduced", 300),
      msg("m4", "All tests green now", 400, {
        events: [
          { kind: "tool_use", content: "**Bash** ctest", toolResult: "crash" },
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "k",
              description: "look",
              events: [{ kind: "text", content: "the crash is in the lexer" }],
            },
          },
        ],
      }),
    ]);
    const search = (q: string, limit = 50) =>
      sidebarHits(s.history, q, sessions, limit).then((hits) => hits.map((h) => h.messageId));
    return { ...s, search };
  }

  it("matches what was said in any case, newest first, never system messages, tools or subagents", async () => {
    const { search } = withHistories();
    expect(await search("CRASH")).toEqual(["m3", "m1"]);
    expect(await search("crash", 1)).toEqual(["m3"]);
  });

  it("requires every word", async () => {
    const { search } = withHistories();
    expect(await search("crash parser")).toEqual(["m1"]);
    expect(await search("crash nonexistent")).toEqual([]);
  });

  it("lets a word be the session's name, but not alone", async () => {
    const { search } = withHistories();
    expect(await search("clice crash")).toEqual(["m1"]);
    expect(await search("clice")).toEqual([]);
  });

  it("gives a short one-line snippet around the first match", async () => {
    const { history, save } = setup();
    save("w4", [msg("mL", `${"x".repeat(500)} needle here ${"y".repeat(500)}\nnext line`, 50)]);
    const [hit] = await sidebarHits(history, "needle", [{ id: "w4", name: "long" }], 5);
    expect(hit).toMatchObject({ workspaceId: "w4", workspaceName: "long", timestamp: 50 });
    expect(hit.snippet).toContain("needle");
    expect(hit.snippet).not.toContain("\n");
    expect(hit.snippet.length).toBeLessThan(120);
    expect(hit.snippet.startsWith("...")).toBe(true);
    expect(hit.snippet.endsWith("...")).toBe(true);
  });

  it("finds nothing for an empty query", async () => {
    const { search } = withHistories();
    expect(await search("")).toEqual([]);
    expect(await search("   ")).toEqual([]);
  });
});

describe("a message cut into entries", () => {
  it("keeps what was said, thought and done, subagents' work one level down", () => {
    const events: StreamEvent[] = [
      { kind: "text", content: "Hello (the message's own text)" },
      { kind: "thinking", content: "hm" },
      { kind: "tool_use", content: "**Bash** `ls`", toolUseId: "t1", toolResult: "a\nb" },
      {
        kind: "tool_use",
        content: "**Edit** a.cpp",
        toolInput: { tool: "Edit", file_path: "/a.cpp", old_string: "x", new_string: "y" },
      },
      { kind: "tool_use", content: "**Read** /x", toolUseId: "t2" },
      { kind: "tool_result", content: "late", toolUseId: "t2" },
      { kind: "error", content: "boom" },
      { kind: "notice", content: "skill text", level: "skill" },
      {
        kind: "subagent_start",
        content: "",
        subagent: {
          taskId: "k",
          description: "Explore",
          prompt: "look",
          summary: "done",
          agentType: "Explore",
          events: [
            { kind: "text", content: "found it" },
            { kind: "tool_use", content: "**Grep** x", toolName: "Grep", toolResult: "hit" },
          ],
        },
      },
    ];
    const entries = entriesOf(msg("m", "Hello", 1, { events }));
    expect(entries.map((e) => [e.kind, e.role, e.tool, e.depth, e.text])).toEqual([
      ["said", "agent", null, 0, "Hello"],
      ["thinking", null, null, 0, "hm"],
      ["tool_call", null, "Bash", 0, "**Bash** `ls`"],
      ["tool_output", null, "Bash", 0, "a\nb"],
      [
        "tool_call",
        null,
        "Edit",
        0,
        '**Edit** a.cpp\n{\n  "tool": "Edit",\n  "file_path": "/a.cpp",\n  "old_string": "x",\n  "new_string": "y"\n}',
      ],
      ["tool_call", null, "Read", 0, "**Read** /x"],
      ["tool_output", null, "Read", 0, "late"],
      ["error", null, null, 0, "boom"],
      ["subagent", null, "Explore", 0, "Explore\n\nlook\n\ndone"],
      ["said", "subagent", null, 1, "found it"],
      ["tool_call", null, "Grep", 1, "**Grep** x"],
      ["tool_output", null, "Grep", 1, "hit"],
    ]);
    expect(entriesOf(msg("s", "joined", 1, { kind: "system" }))).toEqual([]);
  });
});

describe("the search index", () => {
  const find = (history: HistoryService, word: string) =>
    history
      .search({ terms: [word], limit: 10 })
      .then((r) => r.hits.map((h) => `${h.session}/${h.message}`));

  it("follows the history: edits, removals, and a turn only once it is over", async () => {
    const { history, save, base } = setup();
    const turn = msg("m2", "still thinking about zebras", 2, { status: "streaming" });
    save("w1", [msg("m1", "zebra one", 1), turn]);
    expect(await find(history, "zebra")).toEqual(["w1/m1"]);
    save("w1", [msg("m1", "giraffe one", 1), { ...turn, status: "done" }]);
    expect(await find(history, "zebra")).toEqual(["w1/m2"]);
    expect(await find(history, "giraffe")).toEqual(["w1/m1"]);
    save("w1", [msg("m1", "giraffe one", 1)]);
    expect(await find(history, "zebra")).toEqual([]);
    historyOf(base).delete("w1");
    history.changed();
    expect(await find(history, "giraffe")).toEqual([]);
    // Private, its side files too.
    for (const f of [historyIndexFile(base), `${historyIndexFile(base)}-wal`]) {
      expect(fs.statSync(f).mode & 0o077).toBe(0);
    }
  });

  it("is rebuilt when its format changes, or when it is gone", async () => {
    const { history, save, base } = setup();
    save("w1", [msg("m1", "zebra one", 1)]);
    expect(await find(history, "zebra")).toEqual(["w1/m1"]);
    await history.close();
    const db = new DatabaseSync(historyIndexFile(base));
    db.exec("pragma user_version = 0");
    db.close();
    expect(await find(history, "zebra")).toEqual(["w1/m1"]);
    await history.close();
    fs.rmSync(historyIndexFile(base));
    expect(await find(history, "zebra")).toEqual(["w1/m1"]);
  });

  it("says what is wrong with a pattern", async () => {
    const { history, save } = setup();
    save("w1", [msg("m1", "zebra", 1)]);
    await expect(history.search({ terms: [], regex: "(", limit: 5 })).rejects.toThrow(
      "Invalid regular expression",
    );
  });

  it("answers SQL read-only, a fresh connection each time, up to a number of rows", async () => {
    const { history, save } = setup();
    save("w1", [msg("m1", "one", 1), msg("m2", "two", 2), msg("m3", "three", 3)]);
    const r = await history.sql("select message from entries order by ts", [], 2);
    expect(r).toEqual({
      columns: ["message"],
      rows: [{ message: "m1" }, { message: "m2" }],
      truncated: true,
    });
    await history.sql("detach database history", [], 5);
    expect((await history.sql("select count(*) as n from messages", [], 5)).rows).toEqual([
      { n: 3 },
    ]);
    await expect(history.sql("drop table entries", [], 5)).rejects.toThrow("readonly");
  });
});

describe("what a workspace marks for the next save", () => {
  function workspace() {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-1", "t", "p", "local", "/tmp", registry);
    ws.addAgent("A", "claude-opus-5-5", "a", "#888", { backend: "claude" });
    const emit = (e: Partial<StreamEvent>) => host.lastSession!.emit("event", e);
    return { ws, emit };
  }

  it("every message an event changed, finished ones included", () => {
    const { ws, emit } = workspace();
    ws.takeChanged();
    emit({ kind: "text_delta", content: "Hi" });
    const [reply] = ws.messages.filter((m) => m.kind === "agent");
    expect([...ws.takeChanged()]).toEqual([reply.id]);
    expect(ws.takeChanged().size).toBe(0);
    emit({ kind: "result", content: "" });
    expect([...ws.takeChanged()]).toEqual([reply.id]);
  });

  it("a turn a restart cut short", () => {
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const state: WorkspaceState = {
      id: "ws-1",
      name: "t",
      project: "p",
      hostId: "local",
      cwd: "/tmp",
      agents: [],
      createdAt: 1,
      messages: [msg("m1", "done", 1), msg("m2", "half", 2, { status: "streaming" })],
    };
    const ws = Workspace.fromState(state, registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    expect([...ws.takeChanged()]).toEqual(["m2"]);
  });
});
