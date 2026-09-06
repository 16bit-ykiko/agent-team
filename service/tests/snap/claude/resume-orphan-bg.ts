import { expect } from "vitest";
import { fixture, send, wait, end, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "resuming past a background task the previous process left behind must not end our turn on the CLI's phantom result",
  steps: [
    send(
      "Run `sleep 120; echo late` with the Bash tool with run_in_background set to true. Do not wait for it and do not poll it; reply with the single word started right away.",
    ),
    wait("result"),
    end(),
    send("Reply with the single word two."),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages).toHaveLength(2);
    const resumed = messages[1];
    // One reply to our prompt, not an empty one plus a wake-up.
    expect(resumed.content.trim()).toBe("two");
    expect(resumed.status).toBe("done");
    expect(r.events.filter((e) => e.kind === "result")).toHaveLength(2);
    expect(r.events.some((e) => e.kind === "notice" && e.level === "wakeup")).toBe(false);
    // The orphaned task is mentioned, folded, not a card.
    const notice = resumed.events!.find((e) => e.kind === "notice")!;
    expect(notice).toMatchObject({ level: "warning" });
    expect(notice.content).toContain("previous session");
    expect(resumed.events!.some((e) => e.kind === "subagent_start")).toBe(false);
  },
});
