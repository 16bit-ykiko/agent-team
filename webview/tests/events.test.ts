import { describe, it, expect } from "vitest";
import { splitEvents, timelineBlocks, hasRunningSubagents } from "../src/events";
import { StreamEvent } from "../src/useServer";

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

describe("hasRunningSubagents", () => {
  it("is true while any subagent_start is still in the running state", () => {
    expect(
      hasRunningSubagents([
        ev("subagent_start", { subagent: { taskId: "a", description: "", status: "running" } }),
      ]),
    ).toBe(true);
  });

  it("is false for terminal states, plain events, or no events", () => {
    expect(
      hasRunningSubagents([
        ev("subagent_start", { subagent: { taskId: "a", description: "", status: "completed" } }),
        ev("subagent_start", { subagent: { taskId: "b", description: "", status: "stopped" } }),
        ev("tool_use"),
      ]),
    ).toBe(false);
    expect(hasRunningSubagents([])).toBe(false);
    expect(hasRunningSubagents(undefined)).toBe(false);
  });
});

describe("banner events", () => {
  it("separates compact/notice/retry banners from regular events", () => {
    const events = [
      ev("thinking"),
      ev("compact", { content: "compacted" }),
      ev("notice", { content: "fyi", level: "notice" }),
      ev("retry", { content: "retry" }),
      ev("tool_use"),
    ];
    const { regular, banners, subagents } = splitEvents(events);
    expect(regular.map((e) => e.kind)).toEqual(["thinking", "tool_use"]);
    expect(banners.map((e) => e.kind)).toEqual(["compact", "notice", "retry"]);
    expect(subagents).toEqual([]);
  });
});

describe("timelineBlocks", () => {
  it("splits runs of ordinary events at every card, in timeline order", () => {
    const events = [
      ev("thinking"),
      ev("tool_use", { toolName: "Read" }),
      ev("subagent_start", { subagent: { taskId: "a", description: "review" } }),
      ev("tool_use", { toolName: "Bash" }),
      ev("retry", { content: "API retry 1/10" }),
      ev("subagent_progress", { subagent: { taskId: "a", description: "", lastTool: "Grep" } }),
      ev("tool_use", { toolName: "Edit" }),
      ev("subagent_done", { subagent: { taskId: "a", description: "", status: "completed" } }),
      ev("tool_use", { toolName: "Bash" }),
    ];
    const blocks = timelineBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["steps", "subagent", "steps", "banner", "steps"]);
    // Each step box counts only its own run.
    expect((blocks[0] as { events: unknown[] }).events).toHaveLength(2);
    expect((blocks[2] as { events: unknown[] }).events).toHaveLength(1);
    expect((blocks[4] as { events: unknown[] }).events).toHaveLength(2);
    // The card sits where the subagent started and carries its final state.
    const card = (blocks[1] as { ev: StreamEvent }).ev;
    expect(card.subagent?.status).toBe("completed");
    expect(card.subagent?.description).toBe("review");
  });

  it("keeps consecutive cards as separate blocks and no empty step boxes", () => {
    const events = [
      ev("subagent_start", { subagent: { taskId: "a", description: "one" } }),
      ev("subagent_start", { subagent: { taskId: "b", description: "two" } }),
      ev("notice", { content: "n" }),
    ];
    expect(timelineBlocks(events).map((b) => b.kind)).toEqual(["subagent", "subagent", "banner"]);
    expect(timelineBlocks([])).toEqual([]);
  });
});

describe("timelineBlocks details", () => {
  it("folds a summarised done event without losing the start's count or type", () => {
    const events = [
      ev("subagent_start", {
        subagent: { taskId: "a", description: "review", agentType: "Explore", eventCount: 36 },
      }),
      ev("subagent_done", {
        subagent: { taskId: "a", description: "", status: "completed", eventCount: 0 },
      }),
    ];
    const card = (timelineBlocks(events)[0] as { ev: StreamEvent }).ev;
    expect(card.subagent).toMatchObject({
      status: "completed",
      eventCount: 36,
      agentType: "Explore",
      description: "review",
    });
  });

  it("hides the tool_use that spawned a card; per-block step numbers are not boundaries", () => {
    const events = [
      ev("tool_use", { toolName: "Agent", toolUseId: "t1", step: 1 }),
      ev("subagent_start", { toolUseId: "t1", subagent: { taskId: "a", description: "d" } }),
      ev("tool_use", { toolName: "Read", step: 2 }),
      ev("thinking", { step: 3 }),
      ev("tool_use", { toolName: "Bash", step: 4 }),
    ];
    const blocks = timelineBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(["subagent", "steps"]);
    expect((blocks[1] as { events: unknown[] }).events).toHaveLength(3);
    expect(splitEvents(events).regular).toHaveLength(3);
  });
});
