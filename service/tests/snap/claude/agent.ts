import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a foreground subagent is a card with its transcript; the spawning Task call is linked, not duplicated",
  steps: [
    send(
      "Use the Agent tool (subagent_type general-purpose, foreground) with this prompt: 'Run `echo sub` with Bash and report its output.' Then reply with what the subagent reported.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const evs = m.events!;
    expect(kinds(evs)).toEqual(["tool_use", "subagent_start"]);
    expect(evs[1].toolUseId).toBe(evs[0].toolUseId);
    expect(evs[0].toolResultIsMarkdown).toBe(true);
    const card = evs[1].subagent!;
    expect(card).toMatchObject({
      agentType: "general-purpose",
      taskType: "local_agent",
      status: "completed",
    });
    expect(card.prompt).toContain("echo sub");
    expect(card.events!.map((e) => e.kind)).toEqual(["tool_use", "text"]);
    expect(card.events![0].toolResult).toContain("sub");
    expect(card.summary).toContain("sub");
    expect(card.usage).toEqual({ totalTokens: 15891, toolUses: 1, durationMs: 3958 });
    expect(m.status).toBe("done");

    const start = r.events.find((e) => e.kind === "subagent_start")!.subagent!;
    expect(start).toMatchObject({
      taskId: card.taskId,
      description: "Run echo sub",
      status: "running",
    });
    const progress = r.events.find((e) => e.kind === "subagent_progress" && e.subagent?.usage)!;
    expect(progress.subagent).toMatchObject({
      taskId: card.taskId,
      status: "running",
      lastTool: "Bash",
      usage: { totalTokens: 15104, toolUses: 1, durationMs: 2244 },
    });
    const inner = r.events
      .filter((e) => e.kind === "subagent_progress" && e.subagent?._innerEvent)
      .map((e) => e.subagent!._innerEvent!);
    expect(inner.map((e) => e.kind)).toEqual(["tool_use", "tool_result", "text"]);
    expect(inner[0]).toMatchObject({ toolName: "Bash" });
    expect(inner[1].toolUseId).toBe(inner[0].toolUseId);
    // The last main-loop request (2 + 295 + 27115), not the turn total
    // (54529) and not the subagent's own calls.
    expect(m.context).toEqual({ tokens: 27412, window: 1000000 });
  },
});
