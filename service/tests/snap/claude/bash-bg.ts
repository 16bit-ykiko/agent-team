import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a background command is a shell card showing its command that the notification closes, then a wake-up turn follows",
  steps: [
    send(
      "Run `sleep 6; echo finished` with the Bash tool with run_in_background set to true. Do not wait for it and do not poll it; reply with the single word started right away.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const messages = agentMessages(r);
    expect(messages).toHaveLength(2);
    const first = messages[0].events!;
    expect(kinds(first)).toEqual(["tool_use", "subagent_start"]);
    // The tool call keeps its own result; the card carries the command.
    expect(first[0].toolResult).toContain("background");
    const card = first[1].subagent!;
    expect(card).toMatchObject({ taskType: "local_bash", agentType: "shell", status: "completed" });
    expect(card.prompt).toContain("sleep 6; echo finished");
    expect(card.summary).toContain("exit code 0");
    expect(messages[0].status).toBe("done");
    const start = r.events.find((e) => e.kind === "subagent_start")!.subagent!;
    expect(start).toMatchObject({
      taskId: card.taskId,
      agentType: "shell",
      description: "sleep 6; echo finished",
      status: "running",
    });
    expect(r.events.find((e) => e.kind === "subagent_done")!.subagent).toMatchObject({
      taskId: card.taskId,
      status: "completed",
    });
    // Waiting while it ran, then the notification turn with its banner.
    expect(r.states).toEqual(["waiting", "idle", "working", "idle"]);
    const second = messages[1].events!;
    expect(second[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(second[0].content).toContain("background task");
    expect(messages[1].status).toBe("done");
    expect(r.events.filter((e) => e.kind === "result")).toHaveLength(2);
    // A turn we never prompted for is flagged before any of its output.
    const order = r.events
      .filter((e) => e.kind === "text" || e.kind === "result" || e.kind === "notice")
      .map((e) => e.level ?? e.kind);
    expect(order).toEqual(["text", "result", "wakeup", "text", "result"]);
  },
});
