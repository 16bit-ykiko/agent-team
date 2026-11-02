import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a subagent's own steps arrive nested in its task call's deltas",
  steps: [
    send(
      "Start exactly one subagent with your task tool, in the foreground, with the prompt: `Run the shell command echo sub-ok and reply with its output.` Wait for it, then reply with what it returned.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const card = m.events!.find((e) => e.kind === "subagent_start")!;
    expect(card.subagent).toMatchObject({
      taskType: "local_agent",
      status: "completed",
      summary: "Output:\n\n```\nsub-ok\n```",
    });
    const inner = card.subagent!.events!.filter((e) => e.kind === "tool_use");
    expect(inner.map((e) => [e.toolName, e.toolResult])).toEqual([["Bash", "sub-ok\n"]]);
    const call = m.events!.find((e) => e.kind === "tool_use" && e.toolName === "Agent")!;
    expect(call.toolUseId).toBe(card.toolUseId);
    expect(call.toolResult).toBe("Output:\n\n```\nsub-ok\n```");
  },
});
