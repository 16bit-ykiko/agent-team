import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a subagent resumed by SendMessage starts a background shell while the main agent is idle: the shell's card nests in the resumed card",
  steps: [
    send(
      "Use the Agent tool (subagent_type general-purpose) with run_in_background set to true and this prompt: 'Reply with the single word ready.' Then end your turn with the single word started; do not wait or poll.",
    ),
    wait("idle"),
    send(
      "Use the SendMessage tool to send the agent you started earlier (to: its agentId from the Agent tool result) this message: 'Do these steps in order. 1) Run `sleep 5; echo bgdone` with the Bash tool with run_in_background set to true. 2) Run `sleep 8` with the Bash tool in the foreground. 3) Read the background command's output and reply with it in one line.' As soon as SendMessage returns, end your turn with the single word sent; do not wait, poll or sleep.",
    ),
    wait(20_000),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages).toHaveLength(4);
    expect(messages.every((m) => m.status === "done")).toBe(true);
    const card = (i: number) => messages[i].events!.find((e) => e.kind === "subagent_start")!;
    const first = card(0).subagent!;
    const resumed = card(2).subagent!;
    // The resumed run is announced with the SendMessage call's id, its own
    // frames with the original Agent call's.
    expect(resumed.taskId).toBe(first.taskId);
    expect(card(2).toolUseId).not.toBe(card(0).toolUseId);
    expect(kinds(first.events!)).toEqual(["text"]);
    expect(resumed.status).toBe("completed");
    expect(kinds(resumed.events!)).toEqual([
      "tool_use",
      "subagent_start",
      "tool_use",
      "tool_use",
      "text",
    ]);
    expect(resumed.events![1].subagent).toMatchObject({
      taskType: "local_bash",
      status: "completed",
    });
    expect(
      r.events.some((e) => e.kind === "subagent_start" && e.subagent?.taskType === "local_bash"),
    ).toBe(false);
  },
});
