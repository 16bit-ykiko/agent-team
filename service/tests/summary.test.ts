import { describe, it, expect } from "vitest";
import { summarizeEvent, summarizeMessage } from "../src/summary";
import { StreamEvent } from "../src/claude-session";
import { Message } from "../src/task";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent =>
  ({ kind, content: "", ...over }) as StreamEvent;

describe("summarizeEvent", () => {
  it("keeps only the first line of a tool call and records the sizes", () => {
    const s = summarizeEvent(
      ev("tool_use", {
        toolName: "Bash",
        toolUseId: "t1",
        contentOffset: 12,
        content: "**Bash**\n```bash\nnpm test\n```",
        toolResult: "x".repeat(5000),
        toolResultIsMarkdown: true,
      }),
    );
    expect(s).toEqual({
      kind: "tool_use",
      content: "**Bash**",
      toolName: "Bash",
      toolUseId: "t1",
      contentOffset: 12,
      toolResultIsMarkdown: true,
      bodyLength: 29,
      resultLength: 5000,
    });
  });

  it("drops thinking/text/result bodies but keeps their length", () => {
    expect(summarizeEvent(ev("thinking", { content: "long thoughts" }))).toEqual({
      kind: "thinking",
      content: "",
      contentLength: 13,
    });
    expect(summarizeEvent(ev("tool_result", { content: "out", isMarkdown: true }))).toMatchObject({
      contentLength: 3,
      isMarkdown: true,
    });
  });

  it("keeps banners (they are the visible part) with a cap", () => {
    expect(summarizeEvent(ev("notice", { level: "warning", content: "watch out" }))).toEqual({
      kind: "notice",
      content: "watch out",
      level: "warning",
    });
    expect(summarizeEvent(ev("error", { content: "e".repeat(700) })).content).toHaveLength(601);
  });

  it("reduces subagents to their header and counts", () => {
    const s = summarizeEvent(
      ev("subagent_start", {
        contentOffset: 3,
        subagent: {
          taskId: "t",
          description: "search",
          agentType: "Explore",
          status: "completed",
          prompt: "look everywhere",
          summary: "found it",
          usage: { totalTokens: 10, toolUses: 2, durationMs: 5 },
          events: [ev("tool_use"), ev("tool_result")],
        },
      }),
    );
    expect(s.subagent).toEqual({
      taskId: "t",
      description: "search",
      agentType: "Explore",
      status: "completed",
      usage: { totalTokens: 10, toolUses: 2, durationMs: 5 },
      eventCount: 2,
      hasPrompt: true,
      summaryLength: 8,
    });
    expect(s.contentOffset).toBe(3);
  });
});

describe("summarizeMessage", () => {
  it("marks summarised messages and leaves event-less ones untouched", () => {
    const plain: Message = {
      id: "m",
      kind: "user",
      agentId: null,
      content: "hi",
      timestamp: 0,
      status: "done",
    };
    expect(summarizeMessage(plain)).toBe(plain);
    const rich: Message = { ...plain, kind: "agent", events: [ev("thinking", { content: "x" })] };
    const out = summarizeMessage(rich);
    expect(out.detail).toBe("summary");
    expect(out.events![0].content).toBe("");
    expect(rich.events![0].content).toBe("x");
  });
});
