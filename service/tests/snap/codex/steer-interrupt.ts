import { expect } from "vitest";
import { agentMessages, fixture, interrupt, requeued, send, wait } from "../fixture.ts";

const STEERED = "Also end your reply with the word banana.";

export default fixture({
  description:
    "codex drops a steered message its stopped turn never read: the panel runs it as the next turn",
  steps: [
    send(
      "Run `sleep 20; echo first` as one foreground command and wait for it to finish. Then reply with what it printed.",
    ),
    wait({ frame: '"type":"commandExecution"' }),
    send(STEERED),
    wait(1500),
    interrupt(),
    wait("result"),
    requeued(STEERED),
    wait("idle"),
  ],
  verify(r) {
    const starts = r.sent.filter((s) => s.method === "turn/start");
    const text = (s: (typeof starts)[number]) =>
      (s.params as { input: Array<{ text: string }> }).input[0].text;
    expect(starts.map(text)).toEqual([expect.stringContaining("sleep 20") as string, STEERED]);
    expect(r.sent.filter((s) => s.method === "turn/steer")).toHaveLength(1);
    const [stopped, reply] = agentMessages(r);
    expect(stopped.content).toMatch(/\*\\\[interrupted\\\]\*$/);
    expect(reply.status).toBe("done");
    // The steered message once, answered by the turn it ran as.
    const steered = r.messages.filter((m) => m.content === STEERED);
    expect(steered.map((m) => [m.status, m.steering])).toEqual([["done", undefined]]);
    expect(r.messages.indexOf(steered[0])).toBeLessThan(r.messages.indexOf(reply));
  },
});
