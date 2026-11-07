import { expect } from "vitest";
import { fixture, send, wait, interrupt, stopTask, agentMessages } from "../fixture.ts";

// What Stop could become: Query.interrupt() with perTaskStopAffordance
// declared, while a background shell and a background agent run and a
// foreground command holds the turn. Do the background tasks survive, what
// ends the turn, and does stop_task still reach each task afterwards? (CLI
// 2.1.319 refuses a foreground command that starts with `sleep`.)
export default fixture({
  description: "interrupt with per-task stop declared ends the turn and spares background tasks",
  model: "claude-opus-5-5",
  options: { perTaskStopAffordance: true },
  steps: [
    send(
      "Do exactly these three things, in order, each as its own tool call, and do not poll or check on anything:\n" +
        "1. Run `sleep 300; echo bg-done` with the Bash tool with run_in_background set to true.\n" +
        "2. Start a background agent with the Agent tool with run_in_background set to true; its task: run `python3 -c 'import time; time.sleep(240)'` with the Bash tool in the foreground, then reply done.\n" +
        "3. Run `python3 -c 'import time; time.sleep(90)'; echo fg-done` with the Bash tool in the foreground (run_in_background false) and wait for it.",
    ),
    wait({ frame: "time.sleep(90)" }),
    wait(4000),
    interrupt(),
    wait(8000),
    send(
      "Without calling any tools, say in one line which of your background tasks are still running.",
    ),
    wait("result"),
    wait(3000),
    stopTask({ type: "local_bash" }),
    wait(5000),
    stopTask({ type: "local_agent" }),
    wait(8000),
  ],
  verify(r) {
    const [stopped, answer] = agentMessages(r);
    // Stop ends the turn as the user's stop, not as a failure...
    expect(stopped.status).toBe("done");
    expect(stopped.content).toBe("*\\[interrupted\\]*");
    expect(stopped.events!.some((e) => e.kind === "error")).toBe(false);
    // ...and the background shell and agent live on, past the next turn,
    // until stopped one by one.
    expect(answer.content).not.toBe("");
    const cards = stopped.events!.filter((e) => e.kind === "subagent_start");
    expect(cards.map((c) => c.subagent?.status)).toEqual(["stopped", "stopped"]);
    const ids = cards.map((c) => c.subagent?.taskId);
    const results = r.events.flatMap((e, i) => (e.kind === "result" ? [i] : []));
    const ended = r.events.findIndex(
      (e) => e.kind === "subagent_done" && ids.includes(e.subagent?.taskId),
    );
    expect(ended).toBeGreaterThan(results[1]);
  },
});
