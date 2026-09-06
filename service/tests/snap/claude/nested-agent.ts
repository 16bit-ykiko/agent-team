import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a subagent's own subagent nests inside its card with its transcript; no phantom top-level card for the grandchild",
  steps: [
    send(
      "Use the Agent tool (subagent_type general-purpose) with this prompt: 'Use the Agent tool with subagent_type Explore and the prompt \"List the files in the current directory with Bash ls and report them\", then report what it found.' Then reply with the final report in one line.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const evs = m.events!;
    expect(kinds(evs)).toEqual(["tool_use", "subagent_start"]);
    const outer = evs[1].subagent!;
    expect(outer.status).toBe("completed");
    expect(kinds(outer.events!)).toEqual(["tool_use", "subagent_start", "text"]);
    const inner = outer.events![1].subagent!;
    expect(inner).toMatchObject({ agentType: "Explore", status: "completed" });
    expect(kinds(inner.events!)).toEqual(["tool_use", "text"]);
    expect(inner.events![0].toolResult).toContain("drwx");
    expect(
      r.events.filter((e) => e.kind === "subagent_start" && e.subagent?.taskId === inner.taskId),
    ).toHaveLength(0);
    // The grandchild's start and its own tool call both travel wrapped in
    // the outer card's progress, then the inner card's.
    const nestedStart = r.events.find((e) => e.subagent?._innerEvent?.kind === "subagent_start")!;
    expect(nestedStart.subagent!.taskId).toBe(outer.taskId);
    expect(nestedStart.subagent!._innerEvent!.subagent).toMatchObject({
      taskId: inner.taskId,
      agentType: "Explore",
      status: "running",
    });
    const carrier = r.events.find(
      (e) => e.subagent?._innerEvent?.subagent?._innerEvent?.kind === "tool_use",
    )!;
    expect(carrier.kind).toBe("subagent_progress");
    expect(carrier.subagent!.taskId).toBe(outer.taskId);
    const hop = carrier.subagent!._innerEvent!;
    expect(hop.kind).toBe("subagent_progress");
    expect(hop.subagent!.taskId).toBe(inner.taskId);
    expect(hop.subagent!._innerEvent).toMatchObject({ kind: "tool_use", toolName: "Bash" });
  },
});
