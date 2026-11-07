import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

// A message that reaches the CLI just after it started a fired wake-up's
// turn, before that turn's first output: the CLI answers it in a turn of its
// own after the wake-up's. The panel queues a message sent once the fire has
// started and sends it after the wake-up's result.
export default fixture({
  description: "a message sent as a wake-up fires gets its own turn after the wake-up's",
  steps: [
    send(
      'Call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake W", prompt "Reply with the single word W." and noop false. Then reply with the single word scheduled and end your turn without any other tool call.',
    ),
    wait("result"),
    wait({ frame: '"state":"started"' }),
    send("Reply with the single word M."),
    wait(20_000),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages.map((m) => m.content.trim())).toEqual(["scheduled", "W", "M"]);
    expect(messages[1].events?.[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(messages[2].events?.some((e) => e.kind === "notice")).toBe(false);
  },
});
