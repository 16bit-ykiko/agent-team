import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a plain reply: one agent message finalized by turn.completed, with context read from the rollout and the model's default effort",
  steps: [send("Reply with the single word PONG."), wait("idle")],
  verify(r) {
    const [m] = agentMessages(r);
    expect(agentMessages(r)).toHaveLength(1);
    expect(m.content).toBe("PONG");
    expect(m.status).toBe("done");
    expect(kinds(r.events)).toEqual(["text_delta", "result"]);
    expect(r.events[0].content).toBe("PONG");
    expect(m.context).toEqual({ tokens: 15449, window: 258400 });
    expect(m.effort).toBe("medium");
    const result = r.events.find((e) => e.kind === "result")!;
    expect(result.context).toEqual(m.context);
    expect(result.effort).toBe(m.effort);
    const { usage } = r.sessions[0];
    expect(usage.input_tokens).toBe(15443);
    expect(usage.cache_read_tokens).toBe(12160);
    expect(usage.output_tokens).toBe(6);
  },
});
