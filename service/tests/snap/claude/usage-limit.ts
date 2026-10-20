import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

// The five-hour limit refusing two turns in a row in one process, as it does
// a wake-up or a task's report arriving while the panel waits out the limit.
// The CLI sends its rate_limit_event for the first only; each refused turn
// carries an API-error message (error "rate_limit") and an is_error result.
// The API is a local stand-in (fixture api), so no quota is spent.
export default fixture({
  description: "each turn the usage limit refuses reports the limit, the second one too",
  api: "usage-limit",
  steps: [
    send("Reply with the single word one."),
    wait("result"),
    send("Reply with the single word two."),
    wait("result"),
  ],
  verify(r) {
    expect(r.limits).toHaveLength(2);
    expect(r.limits.map((l) => l.rateLimitType)).toEqual(["five_hour", "five_hour"]);
    const replies = agentMessages(r);
    expect(replies.map((m) => m.status)).toEqual(["error", "error"]);
    for (const m of replies) {
      expect(m.events?.find((e) => e.kind === "error")?.content).toContain(
        "Usage limit reached (five-hour)",
      );
    }
  },
});
