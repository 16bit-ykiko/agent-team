import { describe, it, expect } from "vitest";
import { ClaudeSession, StreamEvent } from "../src/session";

// handleSDKMessage is the seam between the SDK's message stream and our
// StreamEvent protocol. The constructor is inert (no SDK import, no process),
// so we can drive it directly with recorded SDK payloads.
function makeSession() {
  const session = new ClaudeSession({ cwd: "/tmp" });
  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  const dispatch = (msg: unknown) =>
    (session as unknown as { handleSDKMessage(m: unknown): void }).handleSDKMessage(msg);
  return { events, dispatch };
}

function taskStarted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    tool_use_id: "toolu_1",
    description: "investigate the bug",
    session_id: "sess-1",
    ...over,
  };
}

function taskProgress(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: "task-1",
    tool_use_id: "toolu_1",
    description: "investigate the bug",
    summary: "reading files",
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4500 },
    session_id: "sess-1",
    ...over,
  };
}

function taskNotification(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    tool_use_id: "toolu_1",
    status: "completed",
    summary: "all done",
    session_id: "sess-1",
    ...over,
  };
}

describe("task_started → subagent classification", () => {
  it("renders a local_agent task as a subagent", () => {
    const { events, dispatch } = makeSession();
    dispatch(
      taskStarted({ task_type: "local_agent", subagent_type: "Explore", prompt: "look around" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("subagent_start");
    expect(events[0].subagent).toMatchObject({
      taskId: "task-1",
      description: "investigate the bug",
      agentType: "Explore",
      prompt: "look around",
      status: "running",
    });
  });

  it("does not render a background local_bash task as a subagent", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_bash" }));
    dispatch(taskProgress());
    dispatch(taskNotification());

    expect(events).toHaveLength(0);
  });

  it("does not render a local_workflow task as a subagent", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_workflow", workflow_name: "review" }));

    expect(events).toHaveLength(0);
  });

  it("hides skip_transcript housekeeping tasks", () => {
    const { events, dispatch } = makeSession();
    dispatch(
      taskStarted({ task_type: "local_agent", subagent_type: "Explore", skip_transcript: true }),
    );

    expect(events).toHaveLength(0);
  });

  it("falls back to subagent_type presence when task_type is absent (older SDKs)", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ subagent_type: "general-purpose" }));
    dispatch(taskStarted({ task_id: "task-2", tool_use_id: "toolu_2" }));

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("subagent_start");
    expect(events[0].subagent?.taskId).toBe("task-1");
  });

  it("ignores progress/notification for tasks never registered as subagents", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskProgress({ task_id: "unknown" }));
    dispatch(taskNotification({ task_id: "unknown" }));

    expect(events).toHaveLength(0);
  });
});

describe("subagent lifecycle", () => {
  it("emits progress with mapped usage and done with final status", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_agent", subagent_type: "Explore" }));
    dispatch(taskProgress());
    dispatch(taskNotification());

    expect(events.map((e) => e.kind)).toEqual([
      "subagent_start",
      "subagent_progress",
      "subagent_done",
    ]);
    expect(events[1].subagent?.usage).toEqual({ totalTokens: 1200, toolUses: 3, durationMs: 4500 });
    expect(events[2].subagent?.status).toBe("completed");
    expect(events[2].subagent?.summary).toBe("all done");

    // Task is cleaned up after notification; further progress is dropped.
    dispatch(taskProgress());
    expect(events).toHaveLength(3);
  });

  it("marks the Task tool_result as markdown, but not a plain tool_result", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_agent", subagent_type: "Explore" }));

    const toolResult = (toolUseId: string) => ({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "# Report\ndetails" }],
      },
      session_id: "sess-1",
    });
    dispatch(toolResult("toolu_1"));
    dispatch(toolResult("toolu_other"));

    const results = events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0].isMarkdown).toBe(true);
    expect(results[1].isMarkdown).toBeUndefined();
  });

  it("routes a subagent's inner activity as nested events", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_agent", subagent_type: "Explore" }));

    // Assistant turn inside the subagent: a tool_use block.
    dispatch({
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_inner", name: "Read", input: { file_path: "/a" } },
        ],
      },
      session_id: "sess-1",
    });

    const nested = events.filter((e) => e.subagent?._innerEvent);
    expect(nested).toHaveLength(1);
    expect(nested[0].kind).toBe("subagent_progress");
    expect(nested[0].subagent?.taskId).toBe("task-1");
    expect(nested[0].subagent?._innerEvent?.kind).toBe("tool_use");
    expect(nested[0].subagent?._innerEvent?.toolUseId).toBe("toolu_inner");
  });

  it("routes a nested agent task under its parent, and drops nested bash tasks", () => {
    const { events, dispatch } = makeSession();
    dispatch(taskStarted({ task_type: "local_agent", subagent_type: "general-purpose" }));
    // The subagent itself calls Agent (toolu_inner) and a background Bash (toolu_bash).
    dispatch({
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_inner", name: "Agent", input: {} },
          { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
        ],
      },
      session_id: "sess-1",
    });
    const before = events.length;

    dispatch(
      taskStarted({
        task_id: "task-nested",
        tool_use_id: "toolu_inner",
        task_type: "local_agent",
        subagent_type: "Explore",
      }),
    );
    dispatch(
      taskStarted({ task_id: "task-bash", tool_use_id: "toolu_bash", task_type: "local_bash" }),
    );

    expect(events).toHaveLength(before + 1);
    const nestedStart = events[events.length - 1];
    expect(nestedStart.kind).toBe("subagent_progress");
    expect(nestedStart.subagent?.taskId).toBe("task-1");
    expect(nestedStart.subagent?._innerEvent?.kind).toBe("subagent_start");
    expect(nestedStart.subagent?._innerEvent?.subagent?.taskId).toBe("task-nested");
  });
});

describe("rate limit surfacing", () => {
  const rateLimitEvent = (info: Record<string, unknown>) => ({
    type: "rate_limit_event",
    rate_limit_info: info,
    session_id: "sess-1",
  });

  it("emits an error when the subscription limit rejects the turn", () => {
    const { events, dispatch } = makeSession();
    dispatch(
      rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
    expect(events[0].content).toContain("five-hour");
    expect(events[0].content).toContain("Resets at");
  });

  it("stays silent for allowed statuses and dedupes repeats", () => {
    const { events, dispatch } = makeSession();
    dispatch(rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }));
    dispatch(rateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour" }));
    expect(events).toHaveLength(0);

    dispatch(rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }));
    dispatch(rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }));
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);

    // Back to allowed, then rejected again → a fresh error.
    dispatch(rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" }));
    dispatch(rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }));
    expect(events.filter((e) => e.kind === "error")).toHaveLength(2);
  });

  it("joins the errors array on result errors instead of 'Unknown error'", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "result",
      subtype: "error_during_execution",
      errors: ["Usage limit exceeded", "second detail"],
      session_id: "sess-1",
    });

    const err = events.find((e) => e.kind === "error");
    expect(err?.content).toContain("Usage limit exceeded");
    expect(err?.content).toContain("second detail");
  });

  it("falls back to the subtype when a result error carries no message", () => {
    const { events, dispatch } = makeSession();
    dispatch({ type: "result", subtype: "error_max_turns", errors: [], session_id: "sess-1" });
    const err = events.find((e) => e.kind === "error");
    expect(err?.content).toContain("error_max_turns");
  });
});

describe("setProviderEnv", () => {
  it("updates the session config without disturbing an unstarted session", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    session.setProviderEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
    expect(session.config.providerEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-x");
    session.setProviderEnv(undefined);
    expect(session.config.providerEnv).toBeUndefined();
  });
});

describe("rateLimit recovery signal", () => {
  it("emits rateLimit with type and reset on rejection, once per status flip", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const signals: Array<{ rateLimitType?: string; resetsAt?: number }> = [];
    session.on("rateLimit", (info) => signals.push(info));
    const dispatch = (msg: unknown) =>
      (session as unknown as { handleSDKMessage(m: unknown): void }).handleSDKMessage(msg);

    dispatch({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000 },
      session_id: "s",
    });
    dispatch({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000 },
      session_id: "s",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0].rateLimitType).toBe("seven_day");
    expect(signals[0].resetsAt).toBe(1_800_000_000);
  });
});
