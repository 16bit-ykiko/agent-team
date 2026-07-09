import { describe, it, expect, vi } from "vitest";
import { buildFrames, cancelDemoSubagent, DEMO_WS_ID } from "../src/replayFixture";
import { StreamEvent } from "../src/useServer";

type Frame = Record<string, unknown>;

// The fixture is the ground truth for visual review — these tests keep it
// internally consistent so the demo can't silently drift from what the
// renderer expects (unpaired tool results, orphan subagent lifecycles...).
describe("replay fixture integrity", () => {
  const frames = buildFrames();
  const streamEvents = frames
    .filter((f) => f.type === "stream_event")
    .map((f) => ({ messageId: f.messageId as string, event: f.event as StreamEvent }));

  function allEventsOf(messageId: string): StreamEvent[] {
    // Top-level events plus events nested inside subagents (_innerEvent).
    const result: StreamEvent[] = [];
    for (const { messageId: mid, event } of streamEvents) {
      if (mid !== messageId) continue;
      result.push(event);
      const inner = (event.subagent as unknown as Record<string, unknown> | undefined)
        ?._innerEvent as StreamEvent | undefined;
      if (inner) result.push(inner);
    }
    return result;
  }

  const messageIds = [...new Set(streamEvents.map((e) => e.messageId))];

  it("creates the demo workspace before streaming into it", () => {
    const createIdx = frames.findIndex((f) => f.type === "workspace_created");
    const firstStream = frames.findIndex((f) => f.type === "stream_event");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeLessThan(firstStream);
    const ws = frames[createIdx].workspace as Record<string, unknown>;
    expect(ws.id).toBe(DEMO_WS_ID);
  });

  it("announces every streamed message with a new_message frame first", () => {
    for (const mid of messageIds) {
      const newMsgIdx = frames.findIndex(
        (f) => f.type === "new_message" && (f.message as Record<string, unknown>).id === mid,
      );
      const firstEventIdx = frames.findIndex(
        (f) => f.type === "stream_event" && f.messageId === mid,
      );
      expect(newMsgIdx, `new_message for ${mid}`).toBeGreaterThanOrEqual(0);
      expect(newMsgIdx).toBeLessThan(firstEventIdx);
    }
  });

  it("pairs every tool_result with a preceding tool_use", () => {
    for (const mid of messageIds) {
      const events = allEventsOf(mid);
      const seenToolUses = new Set<string>();
      for (const e of events) {
        if (e.kind === "tool_use" && e.toolUseId) seenToolUses.add(e.toolUseId);
        if (e.kind === "tool_result" && e.toolUseId) {
          expect(seenToolUses.has(e.toolUseId), `unpaired tool_result ${e.toolUseId}`).toBe(true);
        }
      }
    }
  });

  it("gives every subagent_done/progress a preceding subagent_start", () => {
    for (const mid of messageIds) {
      const started = new Set<string>();
      for (const e of allEventsOf(mid)) {
        const taskId = e.subagent?.taskId;
        if (!taskId) continue;
        if (e.kind === "subagent_start") started.add(taskId);
        else if (e.kind === "subagent_progress" || e.kind === "subagent_done") {
          // _innerEvent carriers reference their parent taskId, which must be started too.
          expect(started.has(taskId), `orphan ${e.kind} for ${taskId}`).toBe(true);
        }
      }
    }
  });

  it("covers all four terminal states plus a still-running subagent", () => {
    const statuses = new Map<string, string>();
    const started = new Set<string>();
    for (const mid of messageIds) {
      for (const e of allEventsOf(mid)) {
        const sa = e.subagent;
        if (!sa?.taskId) continue;
        if (e.kind === "subagent_start") started.add(sa.taskId);
        if (e.kind === "subagent_done" && sa.status) statuses.set(sa.taskId, sa.status);
      }
    }
    const finals = [...statuses.values()];
    expect(finals).toContain("completed");
    expect(finals).toContain("failed");
    expect(finals).toContain("stopped");
    const running = [...started].filter((t) => !statuses.has(t));
    expect(running.length, "at least one subagent must stay running").toBeGreaterThan(0);
  });

  it("includes a nested subagent (subagent_start inside _innerEvent)", () => {
    const nestedStarts = streamEvents.filter((e) => {
      const inner = (e.event.subagent as unknown as Record<string, unknown> | undefined)
        ?._innerEvent as StreamEvent | undefined;
      return inner?.kind === "subagent_start";
    });
    expect(nestedStarts.length).toBeGreaterThan(0);
  });

  it("keeps message_done content in sync with the streamed text deltas", () => {
    for (const f of frames.filter((f) => f.type === "message_done") as Frame[]) {
      const mid = f.messageId as string;
      const streamed = streamEvents
        .filter((e) => e.messageId === mid && e.event.kind === "text_delta")
        .map((e) => e.event.content)
        .join("");
      // Error-status messages may have the error text appended after the
      // streamed content, mirroring the real server behavior.
      expect(
        (f.content as string).startsWith(streamed),
        `message_done content for ${mid} must start with its streamed deltas`,
      ).toBe(true);
    }
  });

  it("keeps every contentOffset within the final message content", () => {
    for (const f of frames.filter((f) => f.type === "message_done") as Frame[]) {
      const mid = f.messageId as string;
      const len = (f.content as string).length;
      for (const { messageId, event } of streamEvents) {
        if (messageId !== mid || event.contentOffset == null) continue;
        expect(event.contentOffset).toBeLessThanOrEqual(len);
      }
    }
  });
});

describe("cancelDemoSubagent", () => {
  it("emits the subagent_done(stopped) frame a real stopTask would produce", () => {
    const dispatch = vi.fn();
    cancelDemoSubagent(dispatch, "demo-sa-run");
    expect(dispatch).toHaveBeenCalledOnce();
    const frame = dispatch.mock.calls[0][0];
    expect(frame.type).toBe("stream_event");
    expect(frame.workspaceId).toBe(DEMO_WS_ID);
    const event = frame.event as StreamEvent;
    expect(event.kind).toBe("subagent_done");
    expect(event.subagent).toMatchObject({ taskId: "demo-sa-run", status: "stopped" });
  });
});
