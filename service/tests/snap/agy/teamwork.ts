import { expect } from "vitest";
import { agentMessages, fixture, send, wait } from "../fixture.ts";

export default fixture({
  // The subagent is an invoke_subagent call that returns at once; its own
  // work streams nothing.
  description:
    "agy's /teamwork slash command over ACP: what its team of agents shows to the client",
  steps: [
    send(
      "/teamwork Create the file hi.txt containing the single word hi. This is a tiny task: use as few agents as possible and finish as soon as the file exists.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    expect(m.status).toBe("done");
    const call = m.events!.find((e) => e.kind === "tool_use");
    expect(call?.toolName).toBe("Agent");
    expect(call?.content).toContain("Create the file hi.txt");
    expect(call?.toolResult).toMatch(/^Started/);
    // A slash command's prompt is not echoed whole: the reply is no leftover.
    expect(m.events!.some((e) => e.kind === "notice")).toBe(false);
    expect(m.content).toContain("teamwork subagent");
  },
});
