import { expect } from "vitest";
import { fixture, interrupt, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "turn/interrupt stops the running turn and closes its command, the process lives on, and the next message is a new turn on the same thread",
  steps: [
    send("Run `sleep 30; echo late` as one foreground command and wait for it to finish."),
    wait({ frame: '"type":"commandExecution"' }),
    wait(1000),
    interrupt(),
    wait("result"),
    send("Reply with the single word after."),
    wait("idle"),
  ],
  verify(r) {
    const [stopped, next] = agentMessages(r);
    expect(stopped.status).toBe("done");
    expect(stopped.content).toMatch(/\*\\\[interrupted\\\]\*$/);
    // codex sends no item/completed for the command it stopped.
    const call = stopped.events!.find((e) => e.kind === "tool_use")!;
    expect([call.toolResult, call.toolResultIsError]).toEqual(["(interrupted)", true]);
    // A plain 429 (codex gave up retrying) is an error, not a usage limit.
    expect(next.status).toBe("error");
    expect(next.events!.at(-1)?.content).toContain("429 Too Many Requests");
    expect(r.limits).toEqual([]);
    expect(r.sent.filter((s) => s.method === "initialize")).toHaveLength(1);
    expect(r.sessions).toHaveLength(1);
  },
});
