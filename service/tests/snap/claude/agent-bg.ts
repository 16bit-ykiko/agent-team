import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a background subagent's card finishes on its own message after the turn ended, then a wake-up turn follows",
  steps: [
    send(
      "Use the Agent tool (subagent_type general-purpose) with run_in_background set to true and this prompt: 'Run `sleep 4; echo bgsub` with Bash and report its output.' Reply with the single word started right away; do not wait or poll.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages).toHaveLength(2);
    const card = messages[0].events!.find((e) => e.kind === "subagent_start")!.subagent!;
    expect(card.status).toBe("completed");
    expect(card.events!.map((e) => e.kind)).toEqual(["tool_use", "text"]);
    // Its inner foreground command did not become a nested card.
    expect(card.events!.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    expect(messages[0].status).toBe("done");
    expect(messages[0].events![0].toolResultIsMarkdown).toBe(true);
    expect(messages[1].events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(messages[1].events![0].content).toContain("background task");
    // Everything the subagent streamed after our turn ended is nested; the
    // main agent stays waiting (no "working") until the CLI's own turn.
    const resultIdx = r.events.findIndex((e) => e.kind === "result");
    const wakeIdx = r.events.findIndex((e) => e.level === "wakeup");
    const between = r.events.slice(resultIdx + 1, wakeIdx);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((e) => e.kind.startsWith("subagent"))).toBe(true);
    expect(r.states).toEqual(["waiting", "idle", "working", "idle"]);
  },
});
