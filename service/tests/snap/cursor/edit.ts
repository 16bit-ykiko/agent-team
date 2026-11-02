import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "an edit and a new file are tool calls that carry what changed",
  files: { "notes.txt": "title: demo\ncolor: red\nsize: 3\n" },
  steps: [
    send(
      "In notes.txt change the line `color: red` to `color: blue` with an edit; do not rewrite the whole file. Then create a new file hello.txt containing exactly `hi`. Reply with the single word ok.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const edits = m.events!.filter((e) => e.kind === "tool_use" && e.toolName === "Edit");
    // A new file is an edit too; each result is its diff.
    expect(edits.map((e) => e.content)).toEqual([
      "**Edit** `/tmp/sdk-capture/notes.txt`",
      "**Edit** `/tmp/sdk-capture/hello.txt`",
    ]);
    expect(edits[0].toolResult).toContain("-color: red\n+color: blue");
    expect(edits[0].toolResultIsMarkdown).toBe(true);
    expect(edits[1].toolResult).toContain("+hi");
  },
});
