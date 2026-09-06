import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a second prompt resumes the same thread: two replies, two results, one thread id",
  steps: [
    send("Reply with the single word one."),
    wait("idle"),
    send("Reply with the single word two."),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages.map((m) => m.content.trim())).toEqual(["one", "two"]);
    expect(messages.every((m) => m.status === "done")).toBe(true);
    expect(kinds(r.events)).toEqual(["text_delta", "result", "text_delta", "result"]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].sessionId).toBe("01a0775a-5bf6-7ea3-8aa4-6c1048e7820a");
    const { usage } = r.sessions[0];
    expect(usage.turns).toBe(2);
    expect(usage.input_tokens).toBe(15442 + 16022);
  },
});
