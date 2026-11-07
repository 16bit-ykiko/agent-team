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
      'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake A", prompt "Reply with the single word A." and noop false. Then end your turn without any other tool call.',
    ),
    wait("result"),
    wait(2000),
    interrupt(),
    // The fired wake-up's turn ends with its command.
    wait({ frame: '"state":"completed"' }),
    send(
      'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake B", prompt "Reply with the single word B." and noop false. Then end your turn without any other tool call.',
    ),
    wait("result"),
  ],
  verify(r) {
    // Sleeping through the idle interrupt, straight into the fire's turn.
    expect(r.states).toEqual(["sleeping", "working", "idle", "working", "sleeping"]);
    const wake = agentMessages(r).find((m) => m.content.trim() === "A");
    expect(wake?.events?.[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(wake?.events?.[0].content).toContain("Scheduled wake-up fired");
  },
});
