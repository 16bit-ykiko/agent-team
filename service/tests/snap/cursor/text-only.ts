import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a plain reply streams as text deltas and ends the turn with its token usage",
  steps: [send("Reply with the single word pong. Do not use any tools."), wait("result")],
  verify(r) {
    const [m] = agentMessages(r);
    expect(m.content).toBe("pong");
    expect(m.status).toBe("done");
    expect(kinds(m.events!)).toEqual(["thinking"]);
    expect(r.sessions[0].sessionId).toBe("agent-f5f81655-fdd7-4326-823e-97cdbb525f39");
    // The model's parameters go with every send, and force (session/cursor.ts).
    expect(r.sends).toEqual([
      {
        model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
        local: { force: true },
      },
    ]);
    // inputTokens counts the cached prefix too.
    expect(r.sessions[0].usage).toMatchObject({
      input_tokens: 7790 - 3552,
      cache_read_tokens: 3552,
      output_tokens: 33,
      turns: 1,
    });
  },
});
