import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a message sent while a turn runs is steered into it: the reply so far ends, and what the model says after reading it is a reply under it",
  steps: [
    send(
      "Run `sleep 8; echo first` as one foreground command and wait for it to finish. Then reply with what it printed.",
    ),
    wait({ frame: '"type":"commandExecution"' }),
    send("Also end your reply with the word banana."),
    wait("idle"),
  ],
  verify(r) {
    expect(r.messages.map((m) => `${m.kind} ${m.status}`)).toEqual([
      "system done",
      "user done",
      "agent done",
      "user done",
      "agent done",
    ]);
    const [before, after] = agentMessages(r);
    expect(before.events!.find((e) => e.kind === "tool_use")?.toolResult).toBe("first\n");
    expect(after.content.trim()).toBe("first\n\nbanana");
    expect(after.context).toEqual({ tokens: 53296, window: 258400 });
    // Steered under the turn codex runs, tagged with the panel message, a
    // tag codex echoes as the read userMessage's clientId.
    const steer = r.sent.find((s) => s.method === "turn/steer");
    const turn = r.sent.find((s) => s.method === "turn/start");
    expect(steer?.params).toMatchObject({ clientUserMessageId: r.messages[3].id });
    expect(turn).toBeDefined();
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].usage.turns).toBe(1);
  },
});
