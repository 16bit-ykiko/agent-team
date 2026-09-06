import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a Skill tool call injects an isSynthetic user frame mid-turn, which is not a wake-up",
  files: {
    ".claude/skills/hello/SKILL.md":
      "---\nname: hello\ndescription: say hello\n---\nReply with exactly: Hello from the skill.\n",
  },
  steps: [
    send("Use the Skill tool to invoke the skill named hello, then reply with what it said."),
    wait("idle"),
  ],
  verify(r) {
    expect(r.events.filter((e) => e.level === "wakeup")).toHaveLength(0);
    expect(r.events.filter((e) => e.kind === "notice")).toHaveLength(0);
    const [m] = agentMessages(r);
    expect(m.content).toContain("Hello from the skill.");
    expect(m.events![0]).toMatchObject({ kind: "tool_use", toolName: "Skill" });
    expect(m.events![0].toolResult).toContain("Launching skill");
  },
});
