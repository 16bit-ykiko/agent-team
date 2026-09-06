import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a quick foreground command is one paired tool call, no card and no task frames",
  steps: [
    send("Run `echo hi` with the Bash tool, then reply with the single word done."),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    expect(agentMessages(r)).toHaveLength(1);
    expect(kinds(m.events!)).toEqual(["tool_use"]);
    expect(m.events![0].toolName).toBe("Bash");
    expect(typeof m.events![0].toolUseId).toBe("string");
    expect(m.events![0].toolResult).toContain("hi");
    expect(m.events![0].toolResultIsMarkdown).toBeUndefined();
    expect(r.events.some((e) => "raw" in e)).toBe(false);
    expect(r.events.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    expect(m.status).toBe("done");
    expect(m.content).toBe("done");
  },
});
