// Synthetic replay for reviewing every event-rendering path by eye.
// Triggered by the 🎬 button in the sidebar; plays a scripted conversation
// through the exact same dispatch pipeline as live server frames.

export const DEMO_WS_ID = "replay-demo";

const AGENT = {
  id: "demo-agent",
  name: "Demo",
  model: "claude-fable-5",
  avatar: "🎬",
  color: "#a78bfa",
  isDefault: true,
};

type Frame = Record<string, unknown>;

const LONG_OUTPUT = Array.from(
  { length: 60 },
  (_, i) =>
    `${String(i + 1).padStart(3)}  drwxr-xr-x  src/module-${i}/index.ts  ${1000 + i * 37} bytes`,
).join("\n");

const MD_TORTURE = `## Markdown torture test

Paragraph with **bold**, *italic*, \`inline code\`, ~~strikethrough~~ and a [link](https://example.com).

### Lists
1. Ordered item
2. Nested:
   - bullet one
   - bullet two with \`code\`
     - deeper still

- [x] Task done
- [ ] Task pending

### Table

| Component | Status | Coverage |
|-----------|--------|---------:|
| session.ts | ✅ tested | 87% |
| task.ts | ✅ tested | 82% |
| App.tsx | 🚧 partial | 41% |

### Code

\`\`\`typescript
export function splitEvents(events: StreamEvent[]) {
  const regular = events.filter((e) => !isSubagentEvent(e));
  return { regular, subagents: merge(events) };
}
\`\`\`

> Blockquote: subagents render as standalone blocks now.

---

Horizontal rule above. 中文渲染测试：多智能体编排面板。`;

function textDeltas(messageId: string, text: string, chunk = 24): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    frames.push({
      type: "stream_event",
      workspaceId: DEMO_WS_ID,
      messageId,
      event: { kind: "text_delta", content: text.slice(i, i + chunk) },
    });
  }
  return frames;
}

function ev(messageId: string, event: Record<string, unknown>): Frame {
  return { type: "stream_event", workspaceId: DEMO_WS_ID, messageId, event };
}

function subagentInner(
  messageId: string,
  parentTaskId: string,
  innerEvent: Record<string, unknown>,
): Frame {
  return ev(messageId, {
    kind: "subagent_progress",
    content: "",
    subagent: { taskId: parentTaskId, description: "", _innerEvent: innerEvent },
  });
}

export function buildFrames(): Frame[] {
  const frames: Frame[] = [];
  const now = Date.now();

  frames.push({ type: "workspace_deleted", workspaceId: DEMO_WS_ID });
  frames.push({
    type: "workspace_created",
    workspace: {
      id: DEMO_WS_ID,
      name: "🎬 Replay Demo",
      project: "replay-demo",
      hostId: "local",
      cwd: "/demo",
      gitBranch: "demo/render-review",
      prUrl: null,
      prTitle: null,
      agents: [AGENT],
      messages: [],
      createdAt: now,
      messagesLoaded: true,
    },
  });

  // ---- System + user messages -------------------------------------------
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-sys-1",
      kind: "system",
      agentId: null,
      content: `🎬 **${AGENT.name}** joined the team`,
      timestamp: now,
      status: "done",
    },
  });
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-user-1",
      kind: "user",
      agentId: null,
      content: "@Demo 帮我全面检查一下这个仓库，需要的话开几个 subagent 并行搜索。",
      timestamp: now,
      status: "done",
    },
  });

  // ---- Message 1: interleaved text/tools/subagents ----------------------
  const M1 = "demo-msg-1";
  const m1p1 = "I'll inspect the repo first, then fan out subagents for the heavy searching.\n\n";
  const m1p2 =
    "\n\nThe `Edit` above fixed a typo. Now let me delegate the broad searches — watch the five subagent states below (running / completed / failed / stopped / nested).\n\n";
  const m1p3 =
    "\n\nAll subagents have reported back. Summary:\n\n- `session.ts` translates SDK messages\n- `task.ts` aggregates them per message\n- rendering is verified by this very replay\n";

  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M1,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now,
      status: "streaming",
      events: [],
    },
  });

  frames.push(
    ev(M1, {
      kind: "thinking",
      content:
        "The user wants a full review. Plan: read entry points, fix the typo I spotted, then spawn parallel subagents for search coverage.",
      contentOffset: 0,
    }),
  );
  frames.push(...textDeltas(M1, m1p1));

  const off1 = m1p1.length;
  frames.push(
    ev(M1, {
      kind: "tool_use",
      content: "**Read** `server/index.ts`",
      toolUseId: "t-read",
      contentOffset: off1,
    }),
    ev(M1, {
      kind: "tool_result",
      content: "export class Server {\n  private workspaces = new Map()\n  ...\n}",
      toolUseId: "t-read",
    }),
    ev(M1, {
      kind: "tool_use",
      content: "**Edit** `server/task.ts`",
      toolUseId: "t-edit",
      toolInput: {
        tool: "Edit",
        file_path: "server/task.ts",
        old_string: "recieve",
        new_string: "receive",
      },
      contentOffset: off1,
    }),
    ev(M1, {
      kind: "tool_result",
      content: "The file has been updated successfully.",
      toolUseId: "t-edit",
    }),
    ev(M1, {
      kind: "tool_use",
      content: "**Bash** `find src -type f | xargs ls -la` (long output)",
      toolUseId: "t-bash",
      contentOffset: off1,
    }),
    ev(M1, { kind: "tool_result", content: LONG_OUTPUT, toolUseId: "t-bash" }),
  );

  frames.push(...textDeltas(M1, m1p2));
  const off2 = off1 + m1p2.length;

  // Subagent #1: completes normally, with inner tool pairing + markdown summary.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Search the syntax module",
      toolUseId: "t-sa1",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-ok",
        description: "Search the syntax module",
        agentType: "Explore",
        prompt:
          "Read **src/syntax/** and report:\n1. module inventory\n2. mutation entry points\n\nCite `file:line`.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "thinking",
      content: "Starting with the dependency graph.",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "tool_use",
      content: "**Grep** `addEdge` in src/syntax/",
      toolUseId: "sa1-t1",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "tool_result",
      content: "dependency_graph.cpp:88\nscanner.cpp:142",
      toolUseId: "sa1-t1",
    }),
    subagentInner(M1, "demo-sa-ok", {
      kind: "text",
      content: "Found 2 mutation sites, verifying callers now.",
    }),
    ev(M1, {
      kind: "subagent_progress",
      content: "reading dependency_graph.cpp",
      subagent: {
        taskId: "demo-sa-ok",
        description: "Search the syntax module",
        status: "running",
        lastTool: "Read",
        usage: { totalTokens: 8200, toolUses: 4, durationMs: 12000 },
      },
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-ok",
        description: "",
        status: "completed",
        summary:
          "### Syntax module report\n\n- `dependency_graph.cpp:88` — forward edges built here\n- reverse edges are **batch-rebuilt**, not incremental\n\n| entry point | caller |\n|---|---|\n| addEdge | scanner.cpp:142 |",
        usage: { totalTokens: 15400, toolUses: 7, durationMs: 21000 },
      },
    }),
  );

  // Subagent #2: parent with a NESTED subagent inside.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Deep audit with a helper agent",
      toolUseId: "t-sa2",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-parent",
        description: "Deep audit with a helper agent",
        agentType: "general-purpose",
        prompt: "Audit the index module. Spawn an Explore helper if the surface is too large.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "tool_use",
      content: "**Read** `src/index/merged_index.cpp`",
      toolUseId: "sa2-t1",
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "tool_result",
      content: "bool need_update() { return impl != nullptr; }",
      toolUseId: "sa2-t1",
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_start",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "helper: map include_graph",
        agentType: "Explore",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "helper: map include_graph",
        status: "running",
        lastTool: "Grep",
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-nested",
        description: "",
        status: "completed",
        summary: "include_graph maps fid → path_id; PCH files are absent from files().",
        usage: { totalTokens: 4100, toolUses: 3, durationMs: 8000 },
      },
    }),
    subagentInner(M1, "demo-sa-parent", {
      kind: "text",
      content: "Helper confirmed the include_graph gap; folding into my report.",
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-parent",
        description: "",
        status: "completed",
        summary: "Audit done. One nested helper used — its block should render *inside* this one.",
        usage: { totalTokens: 22000, toolUses: 9, durationMs: 30000 },
      },
    }),
  );

  // Subagent #3: fails.
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Run the flaky benchmark",
      toolUseId: "t-sa3",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-fail",
        description: "Run the flaky benchmark",
        agentType: "claude",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-fail", {
      kind: "tool_use",
      content: "**Bash** `./bench --strict`",
      toolUseId: "sa3-t1",
    }),
    subagentInner(M1, "demo-sa-fail", {
      kind: "tool_result",
      content: "Segmentation fault (core dumped)",
      toolUseId: "sa3-t1",
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-fail",
        description: "",
        status: "failed",
        summary: "Benchmark crashed with SIGSEGV — needs a debug build to diagnose.",
        usage: { totalTokens: 3000, toolUses: 1, durationMs: 5000 },
      },
    }),
  );

  // Subagent #4: stopped by the user (what the Cancel button produces).
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Exhaustive license scan",
      toolUseId: "t-sa4",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-stop",
        description: "Exhaustive license scan",
        agentType: "Explore",
        status: "running",
        events: [],
      },
    }),
    ev(M1, {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "demo-sa-stop",
        description: "",
        status: "stopped",
        summary: "Stopped by user before completion.",
        usage: { totalTokens: 900, toolUses: 1, durationMs: 2000 },
      },
    }),
  );

  // Subagent #5: still running at the end (shows spinner + Cancel button).
  frames.push(
    ev(M1, {
      kind: "subagent_start",
      content: "Watch CI for regressions",
      toolUseId: "t-sa5",
      contentOffset: off2,
      subagent: {
        taskId: "demo-sa-run",
        description: "Watch CI for regressions",
        agentType: "general-purpose",
        prompt: "Poll CI until the pipeline settles.",
        status: "running",
        events: [],
      },
    }),
    subagentInner(M1, "demo-sa-run", {
      kind: "tool_use",
      content: "**Bash** `gh run watch`",
      toolUseId: "sa5-t1",
    }),
    ev(M1, {
      kind: "subagent_progress",
      content: "watching CI",
      subagent: {
        taskId: "demo-sa-run",
        description: "Watch CI for regressions",
        status: "running",
        lastTool: "Bash",
        usage: { totalTokens: 1200, toolUses: 1, durationMs: 9000 },
      },
    }),
  );

  // Markdown-rendered Task tool_result + error + compact events.
  frames.push(
    ev(M1, {
      kind: "tool_use",
      content: "**Agent** consolidated report",
      toolUseId: "t-agent",
      contentOffset: off2,
    }),
    ev(M1, {
      kind: "tool_result",
      content:
        "## Consolidated findings\n\n1. reverse edges rebuilt in bulk\n2. `need_update()` conflates dirty & loaded\n\n**Verdict:** ship it.",
      toolUseId: "t-agent",
      isMarkdown: true,
    }),
    ev(M1, {
      kind: "error",
      content:
        "[Claude error] transient 529 — retried automatically (rendering check for error events)",
    }),
    ev(M1, { kind: "compact", content: "Context compacted (auto): 145000 → 60000 tokens, 8.2s" }),
  );

  frames.push(...textDeltas(M1, m1p3));
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M1,
    status: "done",
    content: m1p1 + m1p2 + m1p3,
  });

  // ---- Message 2: quoted user message + markdown torture reply ----------
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: "demo-user-2",
      kind: "user",
      agentId: null,
      content: "整理成一份格式丰富的报告让我检查 markdown 渲染。",
      timestamp: now + 60_000,
      status: "done",
      forwardRef: {
        messageId: M1,
        fromAgent: "Demo",
        fromAvatar: "🎬",
        preview: "All subagents have reported back. Summary: session.ts translates SDK messages...",
      },
    },
  });

  const M2 = "demo-msg-2";
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M2,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now + 61_000,
      status: "streaming",
      events: [],
    },
  });
  frames.push(...textDeltas(M2, MD_TORTURE, 48));
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M2,
    status: "done",
    content: MD_TORTURE,
  });

  // ---- Message 3: error-status message -----------------------------------
  const M3 = "demo-msg-3";
  frames.push({
    type: "new_message",
    workspaceId: DEMO_WS_ID,
    message: {
      id: M3,
      kind: "agent",
      agentId: AGENT.id,
      content: "",
      timestamp: now + 120_000,
      status: "streaming",
      events: [],
    },
  });
  frames.push(...textDeltas(M3, "Attempting one more call..."));
  frames.push(
    ev(M3, {
      kind: "error",
      content: "[Claude error] session expired — message ends in the error state",
    }),
  );
  frames.push({
    type: "message_done",
    workspaceId: DEMO_WS_ID,
    messageId: M3,
    status: "error",
    content:
      "Attempting one more call...\n\n[Claude error] session expired — message ends in the error state",
  });

  return frames;
}

// Frame pacing: fast for deltas, slower for structural frames so the eye can
// follow tool pairing and subagent state transitions.
function frameDelay(frame: Frame): number {
  if (frame.type !== "stream_event") return 250;
  const kind = (frame.event as Record<string, unknown>).kind as string;
  if (kind === "text_delta" || kind === "thinking_delta") return 18;
  if (kind === "subagent_start" || kind === "subagent_done") return 550;
  return 220;
}

export async function startDemoReplay(
  dispatch: (msg: Record<string, unknown>) => void,
): Promise<void> {
  for (const frame of buildFrames()) {
    dispatch(frame);
    await new Promise((r) => setTimeout(r, frameDelay(frame)));
  }
  console.log("[replay-demo] finished");
}

// The demo has no real server task behind it, so Cancel is emulated locally:
// emit the same subagent_done(stopped) frame a real stopTask would produce.
export function cancelDemoSubagent(
  dispatch: (msg: Record<string, unknown>) => void,
  taskId: string,
): void {
  dispatch(
    ev("demo-msg-1", {
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId,
        description: "",
        status: "stopped",
        summary: "Stopped by user (demo — a real run would call `Query.stopTask`).",
      },
    }),
  );
}
