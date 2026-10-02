import { describe, it, expect } from "vitest";
import { summarizeEvent, summarizeMessage } from "../../src/workspace/summary";
import { StreamEvent } from "../../src/session/claude";
import { Message } from "../../src/workspace/workspace";

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
        durationMs: 1234,
      }),
    );
    expect(s).toEqual({
      kind: "tool_use",
      content: "**Bash**",
      toolName: "Bash",
      toolUseId: "t1",
      contentOffset: 12,
      toolResultIsMarkdown: true,
      durationMs: 1234,
      bodyLength: 29,
      resultLength: 5000,
    });
  });

  it("keeps what a panel call sent and got back, as a banner's text, and whether it failed", () => {
    const content = "**message_session** `ws-9`\n\n> please rebase";
    expect(
      summarizeEvent(
        ev("tool_use", {
          toolName: "mcp__panel__message_session",
          content,
          toolResult: "No session ws-9 in this project",
          toolResultIsError: true,
        }),
      ),
    ).toEqual({
      kind: "tool_use",
      toolName: "mcp__panel__message_session",
      content,
      bodyLength: content.length,
      toolResult: "No session ws-9 in this project",
      resultLength: 31,
      toolResultIsError: true,
    });
    const long = summarizeEvent(
      ev("tool_use", {
        toolName: "mcp__panel__message_session",
        content: "x".repeat(700),
        toolResult: "y".repeat(900),
      }),
    );
    expect([
      long.content.length,
      long.bodyLength,
      long.toolResult!.length,
      long.resultLength,
    ]).toEqual([600, 700, 600, 900]);
    // The panel's reads stay in the steps: their first line, as any tool.
    expect(
      summarizeEvent(
        ev("tool_use", {
          toolName: "mcp__panel__read_session",
          content: "**read_session** `ws-1`\nmore",
          toolResult: "y".repeat(900),
        }),
      ),
    ).toEqual({
      kind: "tool_use",
      toolName: "mcp__panel__read_session",
      content: "**read_session** `ws-1`",
      bodyLength: "**read_session** `ws-1`\nmore".length,
      resultLength: 900,
    });
  });

  it("marks a cut text by a length longer than it, even one character over the cap", () => {
    for (const n of [600, 601, 700]) {
      const text = "e".repeat(n);
      const banner = summarizeEvent(ev("error", { content: text }));
      const call = summarizeEvent(
        ev("tool_use", { toolName: "mcp__panel__finish_task", content: text, toolResult: text }),
      );
      const cut = n > 600;
      expect((banner.contentLength ?? n) > banner.content.length, `banner ${n}`).toBe(cut);
      expect(call.bodyLength! > call.content.length, `call ${n}`).toBe(cut);
      expect(call.resultLength! > call.toolResult!.length, `result ${n}`).toBe(cut);
    }
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
    const cut = summarizeEvent(ev("error", { content: "e".repeat(700) }));
    expect([cut.content.length, cut.contentLength]).toEqual([600, 700]);
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
          durationMs: 6,
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
      durationMs: 6,
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
