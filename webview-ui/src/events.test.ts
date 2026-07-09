import { describe, it, expect } from "vitest";
import { splitEvents } from "./events";
import { StreamEvent } from "./useServer";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent =>
  ({ kind, content: "", ...over }) as StreamEvent;

describe("splitEvents", () => {
  it("separates regular events from subagent events", () => {
    const events = [
      ev("thinking"),
      ev("tool_use", { toolUseId: "t1" }),
      ev("subagent_start", { subagent: { taskId: "a", description: "d", events: [] } }),
    ];
    const { regular, subagents } = splitEvents(events);
    expect(regular.map((e) => e.kind)).toEqual(["thinking", "tool_use"]);
    expect(subagents).toHaveLength(1);
    expect(subagents[0].subagent?.taskId).toBe("a");
  });

  it("folds start/progress/done into one entry per taskId", () => {
    const events = [
      ev("subagent_start", {
        subagent: { taskId: "a", description: "explore", events: [ev("tool_use")] },
      }),
      ev("subagent_progress", {
        subagent: { taskId: "a", description: "", lastTool: "Grep" },
      }),
      ev("subagent_done", {
        subagent: { taskId: "a", description: "", status: "completed", summary: "done!" },
      }),
    ];
    const { subagents } = splitEvents(events);
    expect(subagents).toHaveLength(1);
    const sa = subagents[0].subagent!;
    // Final status/summary from done, description from start, inner events kept.
    expect(sa.status).toBe("completed");
    expect(sa.summary).toBe("done!");
    expect(sa.description).toBe("explore");
    expect(sa.events).toHaveLength(1);
  });

  it("keeps distinct taskIds separate and preserves order", () => {
    const events = [
      ev("subagent_start", { subagent: { taskId: "a", description: "first" } }),
      ev("subagent_start", { subagent: { taskId: "b", description: "second" } }),
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "failed" } }),
    ];
    const { subagents } = splitEvents(events);
    expect(subagents.map((s) => s.subagent!.taskId)).toEqual(["a", "b"]);
    expect(subagents[0].subagent?.status).toBe("failed");
    expect(subagents[1].subagent?.status).toBeUndefined();
  });

  it("does not let a progress event downgrade a done state", () => {
    const events = [
      ev("subagent_start", { subagent: { taskId: "a", description: "d" } }),
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "completed" } }),
      ev("subagent_progress", { subagent: { taskId: "a", description: "", status: "running" } }),
    ];
    const { subagents } = splitEvents(events);
    expect(subagents[0].kind).toBe("subagent_done");
    expect(subagents[0].subagent?.status).toBe("completed");
  });

  it("ignores subagent events without a taskId", () => {
    const { regular, subagents } = splitEvents([ev("subagent_progress"), ev("text")]);
    expect(subagents).toHaveLength(0);
    expect(regular.map((e) => e.kind)).toEqual(["text"]);
  });
});
