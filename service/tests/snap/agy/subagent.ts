import { expect } from "vitest";
import { agentMessages, fixture, send, wait } from "../fixture.ts";

export default fixture({
  description:
    "a subagent the agent starts itself: a card of its own filled from its conversation, its report back while the main conversation is idle",
  files: { "a.txt": "a\n", "b.txt": "b\n" },
  steps: [
    send(
      "Use the invoke_subagent tool to start one subagent (inherit your model) with this task: run the shell command `ls` in the current folder and report the file names back to you. Do not run it yourself. When the subagent has reported back, reply with the file names it reported and nothing else.",
    ),
    wait("result"),
    // The subagent works and reports back while this conversation is idle.
    wait(60_000),
  ],
  verify(r) {
    const [m, report] = agentMessages(r);
    expect(m.status).toBe("done");
    // The call gets a card, filled from the subagent's own conversation and
    // closed on its report back here.
    const card = m.events!.find((e) => e.kind === "subagent_start")!.subagent!;
    expect(card).toMatchObject({ taskType: "local_agent", status: "completed" });
    const inner = (card.events ?? []).filter((e) => e.kind === "tool_use");
    expect(inner.some((e) => e.content.includes("ls"))).toBe(true);
    expect(inner.some((e) => e.toolName === "SendMessage")).toBe(true);
    expect(card.summary).toContain("a.txt");
    // The agent's reply to that report: a turn of its own while idle.
    expect(report.content).toContain("b.txt");
    expect(report.events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(r.sessions.at(-1)!.runState).toBe("idle");
  },
});
