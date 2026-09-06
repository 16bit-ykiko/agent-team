import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a long foreground command gets task_started with is_backgrounded=false and stays a plain tool call",
  steps: [
    send(
      "Run `sleep 8; echo slow` with the Bash tool in the foreground (do NOT use run_in_background), wait for it, then reply with the single word done.",
    ),
    wait("idle"),
  ],
  verify(r) {
    expect(r.events.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    const [m] = agentMessages(r);
    expect(kinds(m.events!)).toEqual(["tool_use"]);
    expect(m.events![0].toolResult).toContain("slow");
  },
});
