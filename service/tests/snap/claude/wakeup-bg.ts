import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

// A wake-up falls due while a background command still runs. CLI 2.1.280
// held it until the command ended (its scheduler skipped while the drain
// loop waited for background tasks); 2.1.299 fires it on time.
export default fixture({
  description: "a wake-up due while a background command runs fires on time",
  steps: [
    send(
      'Run `sleep 170; echo finished` with the Bash tool with run_in_background set to true. Then call the ScheduleWakeup tool exactly once with delaySeconds 60, reason "wake W", prompt "Reply with the single word W." and noop false. Then reply with the single word scheduled and end your turn without any other tool call; do not wait for the command and do not poll it. When the command finishes, reply with the single word done and call no tool.',
    ),
    wait("result"),
    wait(250_000),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages.map((m) => m.content.trim())).toEqual(["scheduled", "W", "done"]);
    // Known as the wake-up by the command the CLI starts for it.
    expect(messages[1].events?.[0]).toMatchObject({
      kind: "notice",
      level: "wakeup",
      content: "Scheduled wake-up fired.",
    });
  },
});
