import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a model id Cursor does not know fails the turn with the SDK's error",
  model: "cursor/no-such-model",
  steps: [send("Reply with the single word ok."), wait("result")],
  verify(r) {
    const [m] = agentMessages(r);
    expect(m.status).toBe("error");
    expect(m.events!.map((e) => e.kind)).toEqual(["error"]);
    expect(m.events![0].content).toMatch(/^\[Cursor error\] Cannot use this model: no-such-model/);
    expect(r.sessions[0].sessionId).toBeNull();
  },
});
