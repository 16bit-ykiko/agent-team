import { expect } from "vitest";
import { fixture, send, wait, interrupt, agentMessages } from "../fixture.ts";

export default fixture({
  description: "Stop cancels the run mid-command; the next message continues the same agent",
  steps: [
    send(
      "Run this exact shell command once, in the foreground: `sleep 30; echo late`. Then reply with the single word done.",
    ),
    wait({ frame: "tool-call-started" }),
    wait(3000),
    interrupt(),
    wait("result"),
    send("Reply with the single word after. Do not use any tools."),
    wait("result"),
  ],
  verify(r) {
    const [stopped, next] = agentMessages(r);
    expect(stopped.content).toBe("*\\[interrupted\\]*");
    expect(stopped.status).toBe("done");
    // The cancelled run never completes its command: closed, not running.
    const call = stopped.events!.find((e) => e.kind === "tool_use")!;
    expect(call.toolResult).toBe("Interrupted");
    expect(call.toolResultIsError).toBe(true);
    expect(r.events.filter((e) => e.kind === "error")).toHaveLength(0);
    expect(next.content).toBe("after");
    expect(r.sessions).toHaveLength(1);
    expect(r.sdkCalls).toEqual(["create", "send", "cancel", "send"]);
  },
});
