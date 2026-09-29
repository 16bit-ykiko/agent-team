import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyEventsToMessage,
  applyStreamBatch,
  mergeDetailEvents,
  mergeLatestPage,
  downgradedMessageIds,
  toolNameOf,
  toolSummary,
} from "../src/state/stream";
import { Message, StreamEvent } from "../src/state/useServer";

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

// A subagent_progress carrying one inner event of task `taskId`.
const carrier = (taskId: string, inner: StreamEvent): StreamEvent =>
  ev("subagent_progress", {
    subagent: { taskId, description: "", _innerEvent: inner } as unknown as StreamEvent["subagent"],
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
    // A batch of deltas that change nothing must not defeat memo either.
    expect(applyEventsToMessage(m, [ev("text_delta", { content: "" })])).toBe(m);
  });

  it("is pure: the same batch applied twice gives one inner event (StrictMode)", () => {
    // A start and its first inner event in one batch: React may run the
    // updater twice with the same previous state and the same wire objects.
    const batch = [
      ev("subagent_start", {
        subagent: { taskId: "t", description: "d", status: "running", events: [] },
      }),
      carrier("t", ev("tool_use", { toolUseId: "i1", content: "**Read** a" })),
    ];
    const base = msg();
    applyEventsToMessage(base, batch);
    const second = applyEventsToMessage(base, batch);
    expect(second.events![0].subagent!.events).toHaveLength(1);
    expect(batch[0].subagent!.events).toEqual([]);
  });

  it("keeps untouched subagent cards identical so memoized cards skip", () => {
    const quiet = ev("subagent_start", {
      subagent: { taskId: "a", description: "a", status: "running", events: [] },
    });
    const busy = ev("subagent_start", {
      subagent: { taskId: "b", description: "b", status: "running", events: [] },
    });
    const out = applyEventsToMessage(msg({ events: [quiet, busy] }), [
      carrier("b", ev("tool_use", { toolUseId: "i1" })),
    ]);
    expect(out.events![0]).toBe(quiet);
    expect(out.events![1]).not.toBe(busy);
    expect(out.events![1].subagent!.events).toHaveLength(1);
  });

  it("does not start a partial transcript on a card that was never loaded", () => {
    // From a summary page: the server holds the transcript, the client only
    // its size. Applying the live tail would pass for the whole of it.
    const start = ev("subagent_start", {
      subagent: { taskId: "t", description: "d", status: "running", eventCount: 3 },
    });
    const out = applyEventsToMessage(msg({ events: [start] }), [
      carrier("t", ev("tool_use", { toolUseId: "i4" })),
      carrier("t", ev("tool_result", { toolUseId: "i4", content: "ok" })),
      carrier("t", ev("thinking", { content: "hm" })),
    ]);
    const sa = out.events![0].subagent!;
    expect(sa.events).toBeUndefined();
    // Still more on the server than here: the card offers to load it.
    expect(sa.eventCount).toBe(5);
  });

  it("counts on a never-loaded card what the server's transcript gains, not every carrier", () => {
    const card = ev("subagent_start", {
      subagent: { taskId: "t", description: "d", status: "running", eventCount: 1 },
    });
    // A nested task reports progress three times: the server keeps one
    // entry for it, replaced in place, then its done replaces that entry.
    const progress = ev("subagent_progress", {
      subagent: { taskId: "n", description: "nested", lastTool: "Read" },
    });
    let m = applyEventsToMessage(msg({ events: [card] }), [
      carrier("t", progress),
      carrier("t", progress),
      carrier("t", carrier("n", ev("tool_use", { toolUseId: "deep" }))),
      carrier("t", progress),
    ]);
    expect(m.events![0].subagent!.eventCount).toBe(2);
    m = applyEventsToMessage(m, [
      carrier("t", ev("subagent_done", { subagent: { taskId: "n", description: "" } })),
    ]);
    expect(m.events![0].subagent!.eventCount).toBe(2);
  });
});

describe("applyStreamBatch", () => {
  it("applies each message's events in order when a batch spans messages", () => {
    const ws = { id: "A", messages: [msg({ id: "m1" }), msg({ id: "m2" })] };
    const [out] = applyStreamBatch(
      [ws],
      [
        { wsId: "A", messageId: "m1", event: ev("text_delta", { content: "a" }) },
        { wsId: "A", messageId: "m2", event: ev("text_delta", { content: "x" }) },
        { wsId: "A", messageId: "m1", event: ev("text_delta", { content: "b" }) },
      ],
    );
    expect(out.messages.map((m) => m.content)).toEqual(["ab", "x"]);
  });

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

  it("drops a client transcript shorter than the server's: it has a gap", () => {
    const client = [
      ev("subagent_start", {
        subagent: { taskId: "t", description: "d", events: [ev("tool_use", { toolUseId: "i1" })] },
      }),
    ];
    const server = [
      ev("subagent_start", { subagent: { taskId: "t", description: "d", eventCount: 3 } }),
    ];
    const [start] = mergeDetailEvents(client, server);
    expect(start.subagent!.events).toBeUndefined();
    expect(start.subagent!.eventCount).toBe(3);
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

  it("replaces the list when a message that came live is all the page shares", () => {
    // Held m1..m50; m51..m110 were written while away; m111 arrived by
    // new_message before the resync reply, which holds m62..m111.
    const range = (a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, k) =>
        msg({ id: `m${a + k}`, timestamp: a + k, status: "done" }),
      );
    const out = mergeLatestPage([...range(1, 50), ...range(111, 111)], range(62, 111));
    expect(out.map((m) => m.id)).toEqual(range(62, 111).map((m) => m.id));
  });

  it("keeps a live thinking block across a resync while both sides still stream", () => {
    const cur = msg({ id: "m1", liveThinking: "so far", liveThinkingSince: 1_000 });
    const next = msg({ id: "m1", detail: "summary" });
    expect(mergeLatestPage([cur], [next])[0]).toMatchObject({
      liveThinking: "so far",
      liveThinkingSince: 1_000,
    });
    const done = msg({ id: "m1", status: "done" });
    expect(mergeLatestPage([cur], [done])[0].liveThinking).toBeUndefined();
  });

  it("replaces the list when the page does not reach what the client holds", () => {
    // More arrived while away than fits on a page (m4, m5 are on neither):
    // keeping m1..m3 would leave a gap that paging back never fills.
    const out = mergeLatestPage(
      [1, 2, 3].map((i) => msg({ id: `m${i}`, timestamp: i, status: "done" })),
      [6, 7].map((i) => msg({ id: `m${i}`, timestamp: i, status: "done" })),
    );
    expect(out.map((m) => m.id)).toEqual(["m6", "m7"]);
  });

  it("takes the server's copy of a settled message whose background card finished", () => {
    // agent-bg: the card lives on a turn that is already done; it finished
    // while the socket was down.
    const existing = [
      msg({
        id: "m1",
        timestamp: 1,
        status: "done",
        events: [
          ev("tool_use", { toolUseId: "tu1" }),
          ev("subagent_start", {
            toolUseId: "tu1",
            subagent: {
              taskId: "t1",
              description: "bg",
              status: "running",
              events: [ev("tool_use", { toolUseId: "i1" })],
            },
          }),
        ],
      }),
    ];
    const incoming = [
      msg({
        id: "m1",
        timestamp: 1,
        status: "done",
        detail: "summary",
        events: [
          ev("tool_use", { toolUseId: "tu1" }),
          ev("subagent_start", {
            toolUseId: "tu1",
            subagent: { taskId: "t1", description: "bg", status: "completed", eventCount: 2 },
          }),
          ev("subagent_done", {
            subagent: { taskId: "t1", description: "", status: "completed", eventCount: 0 },
          }),
        ],
      }),
    ];
    const merged = mergeLatestPage(existing, incoming);
    expect(merged[0].events!.find((e) => e.kind === "subagent_start")!.subagent!.status).toBe(
      "completed",
    );
    expect(downgradedMessageIds(existing, merged)).toEqual(["m1"]);
  });

  it("takes the server's copy when a card was stopped by a server restart", () => {
    const card = (status: "running" | "stopped", extra: Partial<StreamEvent["subagent"]> = {}) =>
      ev("subagent_start", { subagent: { taskId: "t", description: "d", status, ...extra } });
    const existing = [msg({ id: "m1", status: "done", events: [card("running", { events: [] })] })];
    const incoming = [
      msg({ id: "m1", status: "done", detail: "summary", events: [card("stopped")] }),
    ];
    expect(mergeLatestPage(existing, incoming)[0].events![0].subagent!.status).toBe("stopped");
  });

  it("does not let a live tail after a resync hide the part it missed", () => {
    // The client had i1 when the socket dropped; the server went on to i3.
    const existing = [
      msg({
        id: "m1",
        timestamp: 1,
        events: [
          ev("subagent_start", {
            subagent: {
              taskId: "T",
              description: "d",
              status: "running",
              events: [ev("tool_use", { toolUseId: "i1" })],
            },
          }),
        ],
      }),
    ];
    const incoming = [
      msg({
        id: "m1",
        timestamp: 1,
        detail: "summary",
        events: [
          ev("subagent_start", {
            subagent: { taskId: "T", description: "d", status: "running", eventCount: 3 },
          }),
        ],
      }),
    ];
    let m = mergeLatestPage(existing, incoming)[0];
    m = applyEventsToMessage(m, [
      carrier("T", ev("tool_use", { toolUseId: "i4" })),
      carrier("T", ev("tool_use", { toolUseId: "i5" })),
      carrier("T", ev("tool_use", { toolUseId: "i6" })),
    ]);
    const sa = m.events![0].subagent!;
    // SubAgentItem loads the transcript while eventCount exceeds what it has.
    expect(sa.eventCount ?? 0).toBeGreaterThan(sa.events?.length ?? 0);
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

describe("thinking tokens", () => {
  it("land on the latest thinking block, and are not listed", () => {
    const m: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a",
      content: "",
      timestamp: 1,
      status: "streaming",
      events: [
        { kind: "thinking", content: "Hm", durationMs: 900 },
        { kind: "tool_use", content: "Read /a", toolUseId: "t1" },
      ],
    };
    const next = applyEventsToMessage(m, [{ kind: "thinking_tokens", content: "", tokens: 42 }]);
    expect(next.events!.map((e) => [e.kind, e.tokens])).toEqual([
      ["thinking", 42],
      ["tool_use", undefined],
    ]);
  });
});

describe("live thinking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const think = (content: string) => ev("thinking_delta", { content });

  it("streams a thinking block into client-only state, never into events", () => {
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg(), [think("")]);
    expect(m).toMatchObject({ liveThinking: "", liveThinkingSince: 1_000 });
    vi.setSystemTime(4_000);
    m = applyEventsToMessage(m, [think("Let me "), think("check.")]);
    expect(m).toMatchObject({ liveThinking: "Let me check.", liveThinkingSince: 1_000 });
    expect(m.events).toEqual([]);
  });

  it("opens a block on a first fragment whose start it missed", () => {
    const m = applyEventsToMessage(msg(), [think("mid-block")]);
    expect(m.liveThinking).toBe("mid-block");
    expect(m.liveThinkingSince).toEqual(expect.any(Number));
  });

  it("restarts on the next block's empty delta", () => {
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg(), [think(""), think("first")]);
    vi.setSystemTime(9_000);
    m = applyEventsToMessage(m, [think("")]);
    expect(m).toMatchObject({ liveThinking: "", liveThinkingSince: 9_000 });
  });

  it("ends when the finished block arrives, keeping only that", () => {
    const m = applyEventsToMessage(msg(), [
      think(""),
      think("plan"),
      ev("thinking", { content: "plan", durationMs: 1200 }),
    ]);
    expect(m.liveThinking).toBeUndefined();
    expect(m.liveThinkingSince).toBeUndefined();
    expect(m.events).toEqual([ev("thinking", { content: "plan", durationMs: 1200 })]);
  });

  it("ends on a delta carrying the block's duration (its text was not returned)", () => {
    const open = applyEventsToMessage(msg(), [think("")]);
    const ended = applyEventsToMessage(open, [
      ev("thinking_delta", { content: "", durationMs: 900 }),
    ]);
    expect(ended).not.toHaveProperty("liveThinking");
    expect(ended.events).toEqual([]);
  });

  it("keeps the block and its timer while a background task reports on the message", () => {
    const bg = ev("subagent_start", {
      subagent: { taskId: "bg", description: "bg", status: "running", events: [] },
    });
    vi.setSystemTime(1_000);
    let m = applyEventsToMessage(msg({ events: [bg] }), [think(""), think("First half. ")]);
    vi.setSystemTime(5_000);
    m = applyEventsToMessage(m, [
      carrier("bg", ev("tool_use", { toolUseId: "x", content: "**Read** a" })),
      ev("subagent_progress", { subagent: { taskId: "bg", description: "", lastTool: "Read" } }),
      think("Second half."),
    ]);
    expect(m.liveThinking).toBe("First half. Second half.");
    expect(m.liveThinkingSince).toBe(1_000);
  });

  it("ends on text or a tool call", () => {
    const open = applyEventsToMessage(msg(), [think(""), think("hm")]);
    expect(
      applyEventsToMessage(open, [ev("text_delta", { content: "Answer" })]),
    ).not.toHaveProperty("liveThinking");
    expect(applyEventsToMessage(open, [ev("tool_use", { toolUseId: "t" })])).not.toHaveProperty(
      "liveThinking",
    );
  });

  it("follows the order of the batch", () => {
    const ended = applyEventsToMessage(msg(), [
      think(""),
      think("a"),
      ev("text_delta", { content: "b" }),
    ]);
    expect(ended.liveThinking).toBeUndefined();
    expect(ended.content).toBe("b");
    const reopened = applyEventsToMessage(msg(), [
      ev("text_delta", { content: "b" }),
      ev("tool_use", { toolUseId: "t" }),
      think(""),
      think("next"),
    ]);
    expect(reopened.liveThinking).toBe("next");
  });

  it("keeps the message identical when a batch changes nothing", () => {
    const open = applyEventsToMessage(msg(), [think("x")]);
    expect(applyEventsToMessage(open, [])).toBe(open);
  });
});
