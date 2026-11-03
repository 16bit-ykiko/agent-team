import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a shell command sent to the background shows as running there; the await after it is unreported",
  steps: [
    send(
      "Start this exact shell command once as a background command, without blocking on it (block_until_ms 0): `sleep 20; echo late`. Then wait for that background command to finish with your await tool, in a single await of up to 60 seconds; do not read its output file, poll, or run any other command. When it has finished, reply with the single word finished.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const calls = m.events!.filter((e) => e.kind === "tool_use");
    // The background command completes at once, empty, without the timeout a
    // foreground one has. The await after it is not reported at all: 20 s
    // with nothing but a tool-requests-listed counting it, which the session
    // shows as a card once it lasts (timed, so cursor-session.test.ts).
    expect(calls.map((c) => c.toolName)).toEqual(["Bash"]);
    expect(calls[0].content).toContain("sleep 20; echo late");
    expect(calls[0].toolResult).toBe("Running in the background.");
    expect(m.content.trim().endsWith("finished")).toBe(true);
  },
});
