import { describe, it, expect } from "vitest";
import { applyEventsToMessage, applyStreamBatch, toolNameOf, toolSummary } from "../src/stream";
import { Message, StreamEvent } from "../src/useServer";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent =>
  ({ kind, content: "", ...over }) as StreamEvent;

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
