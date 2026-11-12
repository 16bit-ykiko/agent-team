import { expect } from "vitest";
import { agentMessages, fixture, send, wait } from "../fixture.ts";

export default fixture({
  description:
    "a background command agy wakes up for while idle shows as a turn of its own, found by session/load; a prompt sent during that wake turn",
  steps: [
    send(
      "Start the shell command `sleep 12 && echo bg-finished` as a background task; do not wait for it. Reply with the single word started and end your turn. Later, when you are told that background command finished, run the shell command `sleep 20 && echo after-wake` in the foreground, wait for it, and reply with the single word woken.",
    ),
    wait("result"),
    // The wake turn's foreground command shows in a load's replay.
    wait({ frame: `"title":"sleep 20` }),
    send("Reply with the single word here."),
    wait("idle"),
  ],
  verify(r) {
    const [first, here, woken] = agentMessages(r);
    expect(first.content.trim()).toBe("started");
    const card = first.events!.find((e) => e.kind === "subagent_start");
    expect(card?.subagent?.taskType).toBe("local_bash");
    expect(card?.subagent?.status).toBe("completed");
    // agy's own turn was under way (its command running) when the message
    // came: what a load had found of it opens that reply, and agy took the
    // message meanwhile.
    expect(here.content.trim()).toBe("here");
    expect(here.events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
    const own = here.events!.find((e) => e.kind === "subagent_start");
    expect(own?.subagent?.prompt).toContain("sleep 20");
    expect(own?.subagent?.status).toBe("completed");
    // The rest of agy's own turn, after that reply: a turn of its own.
    expect(woken.content.trim()).toBe("woken");
    expect(woken.events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
    // Everything agy did ended: nothing left to wait on.
    expect(r.sessions.at(-1)!.runState).toBe("idle");
    expect(r.sessions.at(-1)!.backgroundTaskList).toEqual([]);
  },
});
