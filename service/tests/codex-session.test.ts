import { describe, it, expect } from "vitest";
import { CodexSession } from "../src/codex-session";
import { StreamEvent } from "../src/session";

// handleThreadEvent maps @openai/codex-sdk ThreadEvents onto our StreamEvent
// protocol. The constructor is inert, so we drive it directly.
function makeSession() {
  const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-5.5" });
  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  const dispatch = (ev: unknown) =>
    (session as unknown as { handleThreadEvent(e: unknown): void }).handleThreadEvent(ev);
  return { session, events, dispatch };
}

describe("codex thread event mapping", () => {
  it("captures the thread id for resume", () => {
    const { session, dispatch } = makeSession();
    dispatch({ type: "thread.started", thread_id: "thr_123" });
    expect(session.sessionId).toBe("thr_123");
    expect(session.getState().sessionId).toBe("thr_123");
  });

  it("emits agent messages as text deltas and finalizes on turn.completed", () => {
    const { session, events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Here is the answer." },
    });
    dispatch({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
        reasoning_output_tokens: 5,
      },
    });

    // text_delta is what task.ts accumulates into message content; the
    // "result" event is what flips the message out of the streaming state.
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "result"]);
    expect(events[0].content).toBe("Here is the answer.");
    expect(session.usage.input_tokens).toBe(100);
    expect(session.usage.cache_read_tokens).toBe(40);
    expect(session.usage.output_tokens).toBe(25);
  });

  it("surfaces turn.failed and stream errors instead of swallowing them", () => {
    const { events, dispatch } = makeSession();
    dispatch({ type: "turn.failed", error: { message: "usage limit reached" } });
    dispatch({ type: "error", message: "stream broke" });

    expect(events.map((e) => e.kind)).toEqual(["error", "error"]);
    expect(events[0].content).toContain("usage limit reached");
    expect(events[1].content).toContain("stream broke");
  });

  it("pairs command executions as tool_use/tool_result by item id", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.started",
      item: {
        id: "cmd1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    dispatch({
      type: "item.completed",
      item: {
        id: "cmd1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "file.txt\n",
        exit_code: 0,
        status: "completed",
      },
    });

    expect(events[0].kind).toBe("tool_use");
    expect(events[0].toolUseId).toBe("cmd1");
    expect(events[0].content).toContain("ls -la");
    expect(events[1].kind).toBe("tool_result");
    expect(events[1].toolUseId).toBe("cmd1");
    expect(events[1].content).toBe("file.txt\n");
  });

  it("flags non-zero exit codes in the command result", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: {
        id: "cmd2",
        type: "command_execution",
        command: "false",
        aggregated_output: "boom",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(events[0].content).toContain("(exit code 1)");
  });

  it("maps reasoning to thinking and file changes to an edit summary", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "Let me look." },
    });
    dispatch({
      type: "item.completed",
      item: {
        id: "f1",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
      },
    });

    expect(events[0].kind).toBe("thinking");
    expect(events[1].kind).toBe("tool_use");
    expect(events[1].content).toContain("~ src/a.ts");
    expect(events[1].content).toContain("+ src/b.ts");
  });

  it("keeps non-fatal item errors from finalizing the turn", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "e1", type: "error", message: "transient thing" },
    });
    expect(events[0].kind).toBe("compact");
    expect(events[0].content).toContain("transient thing");
  });
});
