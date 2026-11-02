import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a turn streams its text and each command's output; a silent success and a non-zero exit still complete their call",
  steps: [
    send(
      "Think briefly about the order first. Then run these shell commands one at a time, each as its own command: `echo hi`, then `true`, then `exit 3`, then `for i in 1 2 3; do echo line $i; sleep 1; done`. Do not fix anything. Then reply with one short sentence saying they ran.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    expect(agentMessages(r)).toHaveLength(1);
    expect(m.status).toBe("done");
    // Streamed: one text_delta per delta, the two agent messages a paragraph apart.
    const text = r.events.filter((e) => e.kind === "text_delta").map((e) => e.content);
    expect(text.length).toBeGreaterThan(2);
    expect(m.content).toBe(text.join(""));
    expect(m.content).toContain("order.\n\n\nAll four");
    const calls = m.events!.filter((e) => e.kind === "tool_use");
    expect(calls.map((e) => e.toolName)).toEqual(["Bash", "Bash", "Bash", "Bash"]);
    // The shell codex wraps a command in is not shown.
    expect(calls[0].content).toBe("**Bash**\n```bash\necho hi\n```");
    // codex loses output printed before the call's item/started ("line 1").
    expect(calls.map((e) => e.toolResult)).toEqual([
      "hi\n",
      "(no output)",
      " (exit code 3)",
      "line 2\nline 3\n",
    ]);
    expect(calls[3].durationMs).toBe(2853);
    expect(m.context).toEqual({ tokens: 14448, window: 258400 });
    const start = r.sent.find((s) => s.method === "turn/start");
    expect(start?.params).toMatchObject({ serviceTier: "default", summary: "detailed" });
  },
});
