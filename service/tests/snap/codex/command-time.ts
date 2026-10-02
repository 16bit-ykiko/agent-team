import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a command's run time is the gap between its item.started and item.completed: codex announces a command when it starts, not when it is done",
  steps: [
    send(
      "Run the shell command `sleep 2` once, in the foreground, as its own command. Then reply with the single word done.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const call = m.events!.find((e) => e.kind === "tool_use")!;
    expect(call.content).toContain("sleep 2");
    // Recorded: started and completed 1868 ms apart for a 2 s sleep. The
    // start arrives a little after the command starts, so a codex time runs
    // short by a tenth of a second or two, but it is the command's run.
    expect(call.durationMs).toBeGreaterThan(1500);
  },
});
