import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a rejected model: the failure stream (error + turn.failed) yields exactly one error and the message ends in error",
  model: "gpt-nonexistent-model",
  steps: [send("Reply with the single word PONG."), wait("idle")],
  verify(r) {
    const [m] = agentMessages(r);
    expect(agentMessages(r)).toHaveLength(1);
    expect(m.status).toBe("error");
    expect(kinds(r.events)).toEqual(["notice", "error"]);
    const [notice, error] = r.events;
    expect(notice.level).toBe("warning");
    expect(notice.content).toContain("Model metadata for `gpt-nonexistent-model` not found");
    expect(error.content).toContain("[Codex error]");
    expect(error.content).toContain("not supported when using Codex with a ChatGPT account");
  },
});
