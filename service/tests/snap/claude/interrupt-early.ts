import { expect } from "vitest";
import { fixture, send, wait, interrupt, agentMessages } from "../fixture.ts";

// Stop pressed before the turn shows anything (a slow first response, an
// API retry). What does the CLI send for it? A user text frame between our
// prompt and the first output otherwise reads as a /skill expanding.
export default fixture({
  description: "an interrupt before any output ends the turn as a stop, with no banner",
  model: "claude-opus-5-5",
  options: { perTaskStopAffordance: true },
  steps: [
    send(
      "Think very carefully and at length about the prime factorisation of 2^64 + 1 before you answer, then give it.",
    ),
    wait({ frame: '"subtype":"init"' }),
    interrupt(),
    wait(6000),
    send("Reply with the single word two."),
    wait("result"),
  ],
  verify(r) {
    const [stopped, two] = agentMessages(r);
    expect(stopped.status).toBe("done");
    expect(stopped.content).toBe("*\\[interrupted\\]*");
    expect(stopped.events!.some((e) => e.kind === "notice" || e.kind === "error")).toBe(false);
    expect(two.content.trim()).toBe("two");
  },
});
