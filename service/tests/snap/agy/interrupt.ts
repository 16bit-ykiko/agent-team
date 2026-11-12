import { expect } from "vitest";
import { agentMessages, fixture, interrupt, send, wait } from "../fixture.ts";

export default fixture({
  description: "Stop cancels the running turn and its foreground command; the next turn runs on",
  steps: [
    send(
      "Run the shell command `sleep 30 && echo late` in the foreground and wait for it to finish, then reply with the single word done.",
    ),
    wait({ frame: `"title":"sleep 30` }),
    wait(2000),
    interrupt(),
    wait("result"),
    send("Reply with the single word ok."),
    wait("idle"),
  ],
  verify(r) {
    const [stopped, next] = agentMessages(r);
    expect(stopped.content).toContain("interrupted");
    // The command never ran on: its call closed with the turn.
    const call = stopped.events!.find((e) => e.kind === "tool_use");
    expect(call?.content).toContain("sleep 30");
    expect(call?.toolResult).toBe("Interrupted");
    expect(r.sent.some((s) => s.method === "session/cancel")).toBe(true);
    expect(next.content.trim()).toBe("ok");
  },
});
