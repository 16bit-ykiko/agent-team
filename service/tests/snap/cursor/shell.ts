import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a foreground shell command is one tool call; its output comes with the completed call",
  steps: [
    send(
      "Run this exact shell command once, in the foreground, as a single command: `echo start; sleep 3; echo end`. Then reply with the single word finished.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const call = m.events!.find((e) => e.kind === "tool_use")!;
    expect(call.toolName).toBe("Bash");
    expect(call.content).toContain("echo start; sleep 3; echo end");
    expect(call.toolResult).toBe("start\nend\n");
    expect(call.durationMs).toBe(3384);
    expect(m.content).toBe("finished");
  },
});
