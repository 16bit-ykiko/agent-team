import { expect } from "vitest";
import { fixture, send, wait, interrupt, agentMessages } from "../fixture.ts";

// A scheduled wake-up is no task the CLI lists (stop_task has nothing to
// target). Does an interrupt with no turn running cancel it? It does not:
// wake-up A fires all the same, so cancelling one takes the process down
// (ClaudeSession.cancelWake).
export default fixture({
  description: "an interrupt with no turn running leaves a pending wake-up in place: it fires",
  model: "claude-opus-5-5",
  options: { perTaskStopAffordance: true },
  steps: [
    send(
      'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake A" and prompt "Reply with the single word A.". Then end your turn without any other tool call.',
    ),
    wait("result"),
    wait(2000),
    interrupt(),
    wait(95_000),
    send(
      'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake B" and prompt "Reply with the single word B.". Then end your turn without any other tool call.',
    ),
    wait("result"),
    wait(95_000),
  ],
  verify(r) {
    expect(agentMessages(r).map((m) => m.content)).toContain("A");
  },
});
