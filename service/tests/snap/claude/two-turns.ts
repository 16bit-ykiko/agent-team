import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "two prompts on one live process are two replies with one result each",
  steps: [
    send("Reply with the single word one."),
    wait("result"),
    send("Reply with the single word two."),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages.map((m) => m.content.trim())).toEqual(["one", "two"]);
    expect(messages.every((m) => m.status === "done")).toBe(true);
    expect(r.events.filter((e) => e.kind === "result")).toHaveLength(2);
    expect(r.events.some((e) => e.level === "wakeup")).toBe(false);
  },
});
