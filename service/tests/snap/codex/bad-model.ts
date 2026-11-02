import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a model the account cannot use: the failed turn ends its reply in one error",
  model: "gpt-nonexistent-model",
  steps: [send("Reply with the single word PONG."), wait("idle")],
  verify(r) {
    const [m] = agentMessages(r);
    expect(agentMessages(r)).toHaveLength(1);
    expect(m.status).toBe("error");
    expect(kinds(r.events)).toEqual(["notice", "notice", "error"]);
    // The response body codex passes on, unwrapped.
    expect(r.events.at(-1)?.content).toBe(
      "[Codex error] The 'gpt-nonexistent-model' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(r.limits).toEqual([]);
  },
});
