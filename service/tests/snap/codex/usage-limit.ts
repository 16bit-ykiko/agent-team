import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a turn the usage limit refuses fails with usageLimitExceeded; the window and reset come from the rate-limit update before it, on every refused turn",
  api: "usage-limit",
  steps: [
    send("Reply with the single word one."),
    wait("idle"),
    send("Reply with the single word two."),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages.map((m) => m.status)).toEqual(["error", "error"]);
    expect(r.limits).toEqual([
      { rateLimitType: "five_hour", resetsAt: 1793623800 },
      { rateLimitType: "five_hour", resetsAt: 1793623800 },
    ]);
    expect(messages[0].events!.at(-1)?.content).toMatch(/^Usage limit reached \(five-hour\)\./);
  },
});
