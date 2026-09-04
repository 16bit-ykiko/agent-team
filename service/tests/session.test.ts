import { describe, it, expect } from "vitest";
import { ClaudeSession, StreamEvent } from "../src/session";

// handleSDKMessage is the seam between the SDK's message stream and our
// StreamEvent protocol. The constructor is inert (no SDK import, no process),
// so we can drive it directly with recorded SDK payloads.
function makeSession() {
  const session = new ClaudeSession({ cwd: "/tmp" });
  // Tests drive the SDK stream directly; pretend a prompt was pushed so the
  // first turn is not flagged as self-initiated.
  (session as unknown as { expectingTurn: boolean }).expectingTurn = true;
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

  it("reports again on a new turn even if the previous turn was also rejected", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    const priv = session as unknown as {
      handleSDKMessage(m: unknown): void;
      inputController: unknown;
      pushMessage(m: string): void;
    };
    priv.inputController = { push() {}, end() {} };

    const rejected = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      session_id: "s",
    };
    priv.pushMessage("first");
    priv.handleSDKMessage(rejected);
    priv.handleSDKMessage(rejected); // same turn — deduped
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);

    // User sends another message while still limited: its rejection must
    // surface too (this exact case rendered as an empty bubble in prod).
    priv.pushMessage("second");
    priv.handleSDKMessage(rejected);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(2);
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

  it("resets dedup after a new turn so retry rate limits surface", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const errors: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => {
      if (e.kind === "error") errors.push(e);
    });
    const dispatch = (msg: unknown) =>
      (session as unknown as { handleSDKMessage(m: unknown): void }).handleSDKMessage(msg);

    // Inject a stub inputController so pushMessage doesn't NPE.
    const inner = session as unknown as Record<string, unknown>;
    inner.inputController = { push: () => {}, end: () => {} };

    // First turn: rate limit fires.
    dispatch({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000 },
      session_id: "s",
    });
    expect(errors).toHaveLength(1);

    // Simulate retry: pushMessage resets lastRateLimitStatus.
    (session as unknown as { pushMessage(m: string): void }).pushMessage("retry");

    // Second turn hits the same rate limit — must NOT be swallowed.
    dispatch({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000 },
      session_id: "s",
    });
    expect(errors).toHaveLength(2);
  });
});

describe("CLI banners and activity", () => {
  const sys = (subtype: string, over: Record<string, unknown> = {}) => ({
    type: "system",
    subtype,
    session_id: "sess-1",
    ...over,
  });

  function makeSessionWithChannels() {
    const base = makeSession();
    const session = new ClaudeSession({ cwd: "/tmp" });
    const events: StreamEvent[] = [];
    const activity: Array<string | null> = [];
    const unhandled: unknown[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    session.on("activity", (a: string | null) => activity.push(a));
    session.on("unhandled", (m: unknown) => unhandled.push(m));
    const dispatch = (msg: unknown) =>
      (session as unknown as { handleSDKMessage(m: unknown): void }).handleSDKMessage(msg);
    void base;
    return { events, activity, unhandled, dispatch };
  }

  it("renders slash-command output as reply text", () => {
    const { events, dispatch } = makeSessionWithChannels();
    dispatch(sys("local_command_output", { content: "Total cost: $0.12" }));
    expect(events).toEqual([{ kind: "text_delta", content: "Total cost: $0.12" }]);
  });

  it("maps informational/notification banners to notice events with a level", () => {
    const { events, dispatch } = makeSessionWithChannels();
    dispatch(sys("informational", { content: "hook said no", level: "warning" }));
    dispatch(
      sys("informational", { content: "stopping", level: "info", prevent_continuation: true }),
    );
    dispatch(sys("notification", { text: "heads up", priority: "immediate", key: "k" }));
    dispatch(sys("notification", { text: "fyi", priority: "low", key: "k2" }));
    dispatch(sys("informational", { content: "   ", level: "info" }));
    expect(events.map((e) => [e.kind, e.level, e.content])).toEqual([
      ["notice", "warning", "hook said no"],
      ["notice", "warning", "stopping"],
      ["notice", "warning", "heads up"],
      ["notice", "notice", "fyi"],
    ]);
  });

  it("surfaces API retries as a retry event and an activity label", () => {
    const { events, activity, dispatch } = makeSessionWithChannels();
    dispatch(
      sys("api_retry", {
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 5000,
        error_status: 529,
        error: "overloaded",
      }),
    );
    expect(events[0].kind).toBe("retry");
    expect(events[0].content).toContain("2/10");
    expect(events[0].content).toContain("529");
    expect(events[0].content).toContain("overloaded");
    expect(activity).toEqual(["retrying (2/10)"]);
  });

  it("tracks compaction as activity and reports a failed compact", () => {
    const { events, activity, dispatch } = makeSessionWithChannels();
    dispatch(sys("status", { status: "compacting" }));
    dispatch(sys("status", { status: null, compact_result: "failed", compact_error: "too big" }));
    expect(activity).toEqual(["compacting context", null]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "notice", level: "warning" });
    expect(events[0].content).toContain("too big");
  });

  it("reports permission denials with the tool name and reason", () => {
    const { events, dispatch } = makeSessionWithChannels();
    dispatch(
      sys("permission_denied", {
        tool_name: "Bash",
        tool_use_id: "toolu_9",
        decision_reason_type: "rule",
        decision_reason: "rm -rf is blocked",
      }),
    );
    expect(events[0]).toMatchObject({ kind: "notice", level: "warning", toolUseId: "toolu_9" });
    expect(events[0].content).toContain("Bash");
    expect(events[0].content).toContain("rm -rf is blocked");
  });

  it("shows hooks as activity and only reports failed ones", () => {
    const { events, activity, dispatch } = makeSessionWithChannels();
    dispatch(sys("hook_started", { hook_id: "h1", hook_name: "lint", hook_event: "PostToolUse" }));
    dispatch(
      sys("hook_response", {
        hook_id: "h1",
        hook_name: "lint",
        hook_event: "PostToolUse",
        outcome: "success",
        output: "",
        stdout: "",
        stderr: "",
      }),
    );
    dispatch(sys("hook_started", { hook_id: "h2", hook_name: "fmt", hook_event: "Stop" }));
    dispatch(
      sys("hook_response", {
        hook_id: "h2",
        hook_name: "fmt",
        hook_event: "Stop",
        outcome: "error",
        output: "",
        stdout: "",
        stderr: "prettier not found",
      }),
    );
    expect(activity).toEqual(["hook: lint", null, "hook: fmt", null]);
    expect(events).toHaveLength(1);
    expect(events[0].content).toContain("fmt");
    expect(events[0].content).toContain("prettier not found");
  });

  it("turns long tool calls into an activity label, ignoring subagent progress", () => {
    const { activity, dispatch } = makeSessionWithChannels();
    dispatch({
      type: "tool_progress",
      tool_use_id: "t1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 42.4,
      session_id: "sess-1",
    });
    dispatch({
      type: "tool_progress",
      tool_use_id: "t2",
      tool_name: "Read",
      parent_tool_use_id: "toolu_task",
      elapsed_time_seconds: 3,
      session_id: "sess-1",
    });
    expect(activity).toEqual(["Bash · 42s"]);
  });

  it("clears activity when the turn ends", () => {
    const { activity, dispatch } = makeSessionWithChannels();
    dispatch(sys("status", { status: "compacting" }));
    dispatch({ type: "result", subtype: "success", result: "", session_id: "sess-1" });
    expect(activity).toEqual(["compacting context", null]);
  });

  it("reports auth problems and conversation resets", () => {
    const { events, dispatch } = makeSessionWithChannels();
    dispatch({ type: "auth_status", isAuthenticating: false, output: [], error: "token expired" });
    dispatch({ type: "conversation_reset", new_conversation_id: "new-id", session_id: "old" });
    expect(events[0]).toMatchObject({ kind: "error" });
    expect(events[0].content).toContain("token expired");
    expect(events[1]).toMatchObject({ kind: "notice" });
  });

  it("routes unknown messages to the unhandled channel, and stays quiet on housekeeping", () => {
    const { events, unhandled, dispatch } = makeSessionWithChannels();
    dispatch({ type: "keep_alive" });
    dispatch(sys("background_tasks_changed", { tasks: [] }));
    dispatch(sys("some_future_subtype", { foo: 1 }));
    dispatch({ type: "brand_new_type", session_id: "sess-1" });
    expect(events).toHaveLength(0);
    expect(
      unhandled.map(
        (m) => (m as { type: string; subtype?: string }).subtype ?? (m as { type: string }).type,
      ),
    ).toEqual(["some_future_subtype", "brand_new_type"]);
  });

  it("tags tool_use events with the tool name", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }],
      },
    });
    expect(events[0]).toMatchObject({ kind: "tool_use", toolName: "Read", toolUseId: "t1" });
    expect(events[0]).not.toHaveProperty("raw");
  });
});

describe("subagent output arriving before task_started", () => {
  it("parks nested blocks and replays them once the task registers", () => {
    const { events, dispatch } = makeSession();
    // The Task tool's inner assistant turn shows up first...
    dispatch({
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: "toolu_1",
      message: {
        content: [
          { type: "text", text: "looking around" },
          { type: "tool_use", id: "inner_1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    });
    dispatch({
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "tool_result", tool_use_id: "inner_1", content: "file body" }] },
    });
    expect(events).toHaveLength(0);

    // ...then the task announces itself.
    dispatch(taskStarted({ task_type: "local_agent", subagent_type: "Explore" }));

    expect(events.map((e) => e.kind)).toEqual([
      "subagent_start",
      "subagent_progress",
      "subagent_progress",
      "subagent_progress",
    ]);
    const inner = events.slice(1).map((e) => e.subagent?._innerEvent);
    expect(inner.map((i) => i?.kind)).toEqual(["text", "tool_use", "tool_result"]);
    expect(inner[1]).toMatchObject({ toolName: "Read", toolUseId: "inner_1" });
    expect(events.every((e) => e.subagent?.taskId === "task-1")).toBe(true);
  });

  it("drops parked output when the turn ends without a matching task", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: "toolu_orphan",
      message: { content: [{ type: "text", text: "lost" }] },
    });
    dispatch({ type: "result", subtype: "success", result: "", session_id: "sess-1" });
    dispatch(taskStarted({ task_type: "local_agent", tool_use_id: "toolu_orphan" }));
    expect(events.map((e) => e.kind)).toEqual(["result", "subagent_start"]);
  });
});

describe("context usage and wake-ups", () => {
  it("reports context occupancy on the result event from usage + modelUsage", () => {
    const session = new ClaudeSession({ cwd: "/tmp", model: "claude-fable-5-1[1m]" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    (session as unknown as { handleSDKMessage(m: unknown): void }).handleSDKMessage({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: "s",
      usage: { input_tokens: 4000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 },
      modelUsage: {
        "claude-fable-5-1": { contextWindow: 1000000, inputTokens: 1, outputTokens: 1 },
      },
    });
    expect(events[0]).toMatchObject({
      kind: "result",
      context: { tokens: 84000, window: 1000000 },
    });
  });

  it("omits context when the window is unknown", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "result",
      subtype: "success",
      result: "",
      session_id: "s",
      usage: { input_tokens: 5 },
    });
    expect(events[0].context).toBeUndefined();
  });

  it("renders a CLI-originated user turn (wake-up) as a wakeup notice, not our own echo", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    const s = session as unknown as {
      handleSDKMessage(m: unknown): void;
      lastPushed: string | null;
    };
    s.lastPushed = "watch CI";
    s.handleSDKMessage({
      type: "user",
      session_id: "s",
      parent_tool_use_id: null,
      message: { role: "user", content: "watch CI" },
    });
    s.handleSDKMessage({
      type: "user",
      session_id: "s",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: "Scheduled wake-up: check the deploy" }],
      },
    });
    s.handleSDKMessage({
      type: "user",
      session_id: "s",
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: "user", content: "replayed" },
    });
    expect(events).toEqual([
      { kind: "notice", level: "wakeup", content: "Scheduled wake-up: check the deploy" },
    ]);
    expect(session.isRunning).toBe(true);
  });

  it("formats ScheduleWakeup calls as a readable schedule line", () => {
    const { events, dispatch } = makeSession();
    const call = (input: Record<string, unknown>, id: string) =>
      dispatch({
        type: "assistant",
        session_id: "s",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id, name: "ScheduleWakeup", input }] },
      });
    call({ delaySeconds: 480, reason: "watching CI", prompt: "check CI\nfix if red" }, "t1");
    call({ delaySeconds: 5400, noop: true, reason: "quiet" }, "t2");
    call({ stop: true }, "t3");
    const calls = events.filter((e) => e.kind === "tool_use");
    expect(calls[0].toolName).toBe("ScheduleWakeup");
    expect(calls[0].content).toBe(
      "**ScheduleWakeup** in 8m — watching CI\n\n> check CI\n> fix if red",
    );
    expect(calls[1].content).toBe("**ScheduleWakeup** in 1.5h (no change) — quiet");
    expect(calls[2].content).toBe("**ScheduleWakeup** stop — loop ended");
    // Each call is also announced as a schedule banner.
    expect(events.filter((e) => e.level === "schedule")).toHaveLength(3);
  });
});

describe("self-initiated turns", () => {
  const assistantText = (text: string) => ({
    type: "assistant",
    session_id: "s",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  });

  it("flags a turn that starts without a pushed prompt as a wake-up", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    const s = session as unknown as {
      handleSDKMessage(m: unknown): void;
      expectingTurn: boolean;
      processing: boolean;
    };
    // Our own prompt: pushMessage marks the turn as expected.
    s.expectingTurn = true;
    s.processing = true;
    s.handleSDKMessage(assistantText("scheduled"));
    s.handleSDKMessage({
      type: "result",
      subtype: "success",
      result: "scheduled",
      session_id: "s",
    });
    // A minute later the CLI starts a turn on its own.
    s.handleSDKMessage(assistantText("AWAKE"));
    s.handleSDKMessage({ type: "result", subtype: "success", result: "AWAKE", session_id: "s" });

    expect(events.map((e) => [e.kind, e.level ?? ""])).toEqual([
      ["text", ""],
      ["result", ""],
      ["notice", "wakeup"],
      ["text", ""],
      ["result", ""],
    ]);
    expect(session.isRunning).toBe(false);
  });

  it("does not double-flag when the CLI also emits the injected prompt text", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    const s = session as unknown as { handleSDKMessage(m: unknown): void };
    s.handleSDKMessage({
      type: "user",
      session_id: "s",
      parent_tool_use_id: null,
      message: { role: "user", content: "wake-up text" },
    });
    s.handleSDKMessage(assistantText("AWAKE"));
    expect(events.filter((e) => e.level === "wakeup")).toHaveLength(1);
    expect(events[0].content).toBe("wake-up text");
  });
});

describe("scheduled wake-up banner and sleeping label", () => {
  it("announces the schedule as a banner and sleeps after the turn until the next one starts", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "assistant",
      session_id: "s",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "ScheduleWakeup",
            input: { delaySeconds: 480, reason: "watching CI", prompt: "check CI" },
          },
        ],
      },
    });
    const banner = events.find((e) => e.level === "schedule")!;
    expect(banner.kind).toBe("notice");
    expect(banner.content).toMatch(/^Wake up in 8m \(\d{2}:\d{2}.*\) — watching CI\n\n> check CI$/);
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "notice"]);
  });

  it("sets a sleeping activity after the result and clears it when the wake-up turn starts", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const s = session as unknown as { handleSDKMessage(m: unknown): void; expectingTurn: boolean };
    s.expectingTurn = true;
    const activity: Array<string | null> = [];
    session.on("activity", (a: string | null) => activity.push(a));
    s.handleSDKMessage({
      type: "assistant",
      session_id: "s",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "ScheduleWakeup",
            input: { delaySeconds: 60, reason: "r" },
          },
        ],
      },
    });
    s.handleSDKMessage({ type: "result", subtype: "success", result: "", session_id: "s" });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatch(/^sleeping until \d{2}:\d{2}.* · r$/);
    // the wake-up turn
    s.handleSDKMessage({
      type: "assistant",
      session_id: "s",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "AWAKE" }] },
    });
    expect(activity[activity.length - 1]).toBeNull();
  });

  it("does not sleep after a stop", () => {
    const session = new ClaudeSession({ cwd: "/tmp" });
    const s = session as unknown as { handleSDKMessage(m: unknown): void; expectingTurn: boolean };
    s.expectingTurn = true;
    const events: StreamEvent[] = [];
    const activity: Array<string | null> = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    session.on("activity", (a: string | null) => activity.push(a));
    s.handleSDKMessage({
      type: "assistant",
      session_id: "s",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { stop: true } }],
      },
    });
    s.handleSDKMessage({ type: "result", subtype: "success", result: "", session_id: "s" });
    expect(events.find((e) => e.level === "schedule")!.content).toContain("Loop ended");
    expect(activity).toEqual([]);
  });
});
