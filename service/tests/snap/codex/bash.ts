import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "shell commands pair as tool_use/tool_result by item id; a silent success still completes and a non-zero exit is flagged",
  steps: [
    send(
      "Run these three shell commands one at a time, each as its own command: `echo hi`, then `true`, then `exit 3`. Do not fix anything. Then reply with the single word done.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const text = r.events.filter((e) => e.kind === "text_delta").map((e) => e.content);
    expect(text).toEqual(["I’ll run the three commands separately, in order.", "\n\ndone"]);
    expect(m.content).toBe(text.join(""));
    const uses = r.events.filter((e) => e.kind === "tool_use");
    const results = r.events.filter((e) => e.kind === "tool_result");
    expect(uses.map((e) => e.toolUseId)).toEqual(["item_1", "item_2", "item_3"]);
    expect(results.map((e) => e.toolUseId)).toEqual(["item_1", "item_2", "item_3"]);
    expect(uses.every((e) => e.toolName === "Bash")).toBe(true);
    expect(uses[0].content).toContain("echo hi");
    expect(results.map((e) => e.content)).toEqual(["hi\n", "(no output)", " (exit code 3)"]);
    const tools = m.events!.filter((e) => e.kind === "tool_use");
    expect(tools.map((e) => e.toolResult)).toEqual(["hi\n", "(no output)", " (exit code 3)"]);
    expect(kinds(m.events!).every((k) => k === "tool_use" || k === "thinking")).toBe(true);
    expect(m.status).toBe("done");
  },
});
