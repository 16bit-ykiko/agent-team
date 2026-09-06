import { describe, it, expect } from "vitest";
import {
  applyEventsToMessage,
  applyStreamBatch,
  mergeDetailEvents,
  mergeLatestPage,
  downgradedMessageIds,
  toolNameOf,
  toolSummary,
} from "../src/stream";
import { Message, StreamEvent } from "../src/useServer";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent => ({
  kind,
  content: "",
  ...over,
});

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  kind: "agent",
  agentId: "a",
  content: "",
  timestamp: 0,
  status: "streaming",
  events: [],
  ...over,
});

describe("applyEventsToMessage", () => {
  it("appends text deltas and ignores thinking deltas", () => {
    const out = applyEventsToMessage(msg({ content: "He" }), [
      ev("text_delta", { content: "llo" }),
      ev("thinking_delta", { content: "zzz" }),
    ]);
    expect(out.content).toBe("Hello");
    expect(out.events).toEqual([]);
  });

  it("attaches a tool_result to its tool_use instead of appending it", () => {
    const out = applyEventsToMessage(msg({ events: [ev("tool_use", { toolUseId: "t1" })] }), [
      ev("tool_result", { toolUseId: "t1", content: "42", isMarkdown: true }),
      ev("tool_result", { toolUseId: "missing", content: "orphan" }),
    ]);
    expect(out.events).toHaveLength(2);
    expect(out.events![0]).toMatchObject({ toolResult: "42", toolResultIsMarkdown: true });
    expect(out.events![1]).toMatchObject({ kind: "tool_result", content: "orphan" });
  });

  it("keeps one retry event per message, preserving its position", () => {
    const first = applyEventsToMessage(msg(), [
      ev("retry", { content: "retry 1/10", contentOffset: 3 }),
      ev("notice", { content: "fyi" }),
    ]);
    const second = applyEventsToMessage(first, [ev("retry", { content: "retry 2/10" })]);
    expect(second.events!.map((e) => [e.kind, e.content, e.contentOffset])).toEqual([
      ["retry", "retry 2/10", 3],
      ["notice", "fyi", undefined],
    ]);
  });

  it("folds subagent inner events onto the start event without mutating the input", () => {
    const start = ev("subagent_start", {
      subagent: { taskId: "task", description: "d", status: "running", events: [] },
    });
    const input = msg({ events: [start] });
    const out = applyEventsToMessage(input, [
      ev("subagent_progress", {
        subagent: {
          taskId: "task",
          description: "",
          _innerEvent: ev("tool_use", { toolUseId: "i1", content: "Read" }),
        } as unknown as StreamEvent["subagent"],
      }),
      ev("subagent_progress", {
        subagent: {
          taskId: "task",
          description: "",
          _innerEvent: ev("tool_result", { toolUseId: "i1", content: "body" }),
        } as unknown as StreamEvent["subagent"],
      }),
      ev("subagent_done", {
        subagent: { taskId: "task", description: "", status: "completed", summary: "ok" },
      }),
    ]);
    expect(input.events![0].subagent!.events).toEqual([]);
    const sa = out.events![0].subagent!;
    expect(sa.events).toHaveLength(1);
    expect(sa.events![0]).toMatchObject({ kind: "tool_use", toolResult: "body" });
    expect(sa.status).toBe("completed");
    expect(sa.summary).toBe("ok");
    expect(out.events!.map((e) => e.kind)).toEqual(["subagent_start", "subagent_done"]);
  });

  it("returns the same message object when nothing applies", () => {
    const m = msg();
    expect(applyEventsToMessage(m, [])).toBe(m);
  });
});

describe("applyStreamBatch", () => {
  it("only touches workspaces and messages named in the batch", () => {
    const wsA = { id: "A", messages: [msg({ id: "m1" }), msg({ id: "m2" })] };
    const wsB = { id: "B", messages: [msg({ id: "m1" })] };
    const out = applyStreamBatch(
      [wsA, wsB],
      [{ wsId: "A", messageId: "m2", event: ev("text_delta", { content: "x" }) }],
    );
    expect(out[1]).toBe(wsB);
    expect(out[0].messages[0]).toBe(wsA.messages[0]);
    expect(out[0].messages[1].content).toBe("x");
  });
});

describe("tool name helpers", () => {
  it("prefers the explicit toolName and falls back to the bold prefix", () => {
    expect(
      toolNameOf(ev("tool_use", { toolName: "Bash", content: "**Bash**\n```bash\nls\n```" })),
    ).toBe("Bash");
    expect(toolNameOf(ev("tool_use", { content: "**Read** `a.ts`" }))).toBe("Read");
    expect(toolNameOf(ev("tool_use", { content: "no name" }))).toBeNull();
  });

  it("summarises single-line tool calls without the name or backticks", () => {
    expect(toolSummary(ev("tool_use", { content: "**Read** `src/a.ts`" }))).toBe("src/a.ts");
    expect(toolSummary(ev("tool_use", { content: "**Bash**\n```bash\nls\n```" }))).toBe("");
  });
});

describe("mergeDetailEvents", () => {
  it("takes the server events but keeps client-loaded subagent transcripts", () => {
    const client = [
      ev("subagent_start", {
        subagent: { taskId: "t", description: "", events: [ev("tool_use")] },
      }),
    ];
    const server = [
      ev("thinking", { content: "full body" }),
      ev("subagent_start", { subagent: { taskId: "t", description: "d", eventCount: 1 } }),
    ];
    const merged = mergeDetailEvents(client, server);
    expect(merged[0].content).toBe("full body");
    expect(merged[1].subagent!.events).toHaveLength(1);
    expect(merged[1].subagent!.description).toBe("d");
    expect(mergeDetailEvents(undefined, server)).toBe(server);
  });
});

describe("mergeLatestPage", () => {
  it("takes the server's status for a message that finished while disconnected", () => {
    const live = msg({ id: "m2", timestamp: 2, status: "streaming", content: "par" });
    const done = msg({
      id: "m2",
      timestamp: 2,
      status: "done",
      content: "partial then done",
      events: [ev("tool_use", { toolName: "Read" })],
      detail: "summary",
    });
    const out = mergeLatestPage([msg({ id: "m1", timestamp: 1, status: "done" }), live], [done]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out[1].status).toBe("done");
    expect(out[1].content).toBe("partial then done");
    expect(out[1].detail).toBe("summary");
  });

  it("appends messages that arrived while disconnected, in order", () => {
    const out = mergeLatestPage(
      [msg({ id: "m1", timestamp: 1, status: "done" })],
      [
        msg({ id: "m1", timestamp: 1, status: "done" }),
        msg({ id: "m2", timestamp: 2, status: "done" }),
        msg({ id: "m3", timestamp: 3, status: "streaming" }),
      ],
    );
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps older pages the client scrolled back to and drops removed messages", () => {
    const out = mergeLatestPage(
      [
        msg({ id: "old", timestamp: 0, status: "done" }),
        msg({ id: "m1", timestamp: 1, status: "done" }),
        msg({ id: "gone", timestamp: 2, status: "queued" }),
      ],
      [msg({ id: "m1", timestamp: 1, status: "done" }), msg({ id: "m3", timestamp: 3 })],
    );
    expect(out.map((m) => m.id)).toEqual(["old", "m1", "m3"]);
  });

  it("keeps full bodies the user already expanded when nothing changed", () => {
    const full = [ev("thinking", { content: "long body" })];
    const cur = msg({ id: "m1", timestamp: 1, status: "done", events: full });
    const summary = msg({
      id: "m1",
      timestamp: 1,
      status: "done",
      events: [ev("thinking", { contentLength: 9 })],
      detail: "summary",
    });
    const out = mergeLatestPage([cur], [summary]);
    expect(out[0].events).toBe(full);
    expect(out[0].detail).toBeUndefined();
  });

  it("carries client-loaded subagent transcripts across a resync", () => {
    const inner = [ev("tool_use", { toolName: "Grep" })];
    const cur = msg({
      id: "m1",
      timestamp: 1,
      status: "streaming",
      events: [
        ev("subagent_start", { subagent: { taskId: "t", description: "d", events: inner } }),
      ],
    });
    const next = msg({
      id: "m1",
      timestamp: 1,
      status: "done",
      events: [
        ev("subagent_done", { subagent: { taskId: "t", description: "d", status: "completed" } }),
      ],
      detail: "summary",
    });
    const out = mergeLatestPage([cur], [next]);
    expect(out[0].status).toBe("done");
    expect(out[0].events?.[0].subagent?.events).toBe(inner);
  });

  it("an empty newest page means the workspace has no messages", () => {
    expect(mergeLatestPage([msg({ id: "m1" })], [])).toEqual([]);
  });
});

describe("downgradedMessageIds", () => {
  it("names messages that had bodies and came back as summaries", () => {
    const existing = [
      msg({ id: "live", status: "streaming", events: [ev("thinking", { content: "body" })] }),
      msg({ id: "page", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "empty", status: "done", events: [] }),
    ];
    const merged = [
      msg({ id: "live", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "page", status: "done", events: [ev("thinking")], detail: "summary" }),
      msg({ id: "empty", status: "done", events: [] }),
      msg({ id: "new", status: "done", events: [ev("thinking")], detail: "summary" }),
    ];
    expect(downgradedMessageIds(existing, merged)).toEqual(["live"]);
  });
});

describe("robustness", () => {
  it("tolerates events without content and keeps the start's description on done", () => {
    expect(toolNameOf({ kind: "tool_use" } as StreamEvent)).toBeNull();
    expect(toolSummary({ kind: "tool_use" } as StreamEvent)).toBe("");
    const start = msg({
      events: [
        ev("subagent_start", {
          subagent: { taskId: "a", description: "review", agentType: "Explore", events: [] },
        }),
      ],
    });
    const out = applyEventsToMessage(start, [
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "completed" } }),
    ]);
    expect(out.events![0].subagent).toMatchObject({
      status: "completed",
      description: "review",
      agentType: "Explore",
    });
  });

  it("keeps a same-millisecond neighbour that is not on the incoming page", () => {
    const out = mergeLatestPage(
      [msg({ id: "old", timestamp: 5, status: "done" }), msg({ id: "m1", timestamp: 5 })],
      [msg({ id: "m1", timestamp: 5, status: "done" })],
    );
    expect(out.map((m) => m.id)).toEqual(["old", "m1"]);
  });
});
