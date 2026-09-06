import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a /skill typed by the user produces no user frame and is never a wake-up",
  files: {
    ".claude/skills/hello/SKILL.md":
      "---\nname: hello\ndescription: say hello\n---\nReply with exactly: Hello from the skill.\n",
  },
  steps: [send("/hello"), wait("idle")],
  verify(r) {
    expect(r.events.filter((e) => e.level === "wakeup")).toHaveLength(0);
    expect(agentMessages(r)[0].content).toContain("Hello from the skill.");
  },
});
