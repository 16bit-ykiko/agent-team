// Merges the server's task.test.ts checks on its side, here on the client's:
// both must build the same transcript (snap.test.ts asserts it per fixture,
// these for what no fixture records).
import { describe, it, expect } from "vitest";
import type { StreamEvent } from "../../src/session/claude";
import { applyEventsToMessage } from "../../../webview/src/state/stream";
import type { StreamEvent as ClientEvent } from "../../../webview/src/state/useServer";

describe("the client's merges", () => {
  it("keeps a card's time when a later end carries none", () => {
    const start: StreamEvent = {
      kind: "subagent_start",
      content: "",
      subagent: { taskId: "task-1", description: "look", status: "running", events: [] },
    };
    const end = (durationMs?: number): StreamEvent => ({
      kind: "subagent_done",
      content: "",
      subagent: {
        taskId: "task-1",
        description: "",
        status: "completed",
        ...(durationMs != null && { durationMs }),
      },
    });
    const msg = applyEventsToMessage(
      {
        id: "m",
        kind: "agent",
        agentId: "a",
        content: "",
        timestamp: 0,
        status: "streaming",
        events: [],
      },
      [start, end(6000), end()] as ClientEvent[],
    );
    const card = msg.events!.find((e) => e.kind === "subagent_start")!;
    expect(card.subagent?.durationMs).toBe(6000);
  });
});
