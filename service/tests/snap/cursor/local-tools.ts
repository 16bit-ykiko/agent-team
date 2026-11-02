import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "listing, globbing, grepping, deleting and a todo list are tool calls of their own",
  files: {
    "a.txt": "color: red\n",
    "b.md": "nothing here\n",
    "sub/c.txt": "color: green\n",
    "old.log": "stale\n",
  },
  steps: [
    send(
      [
        "Do these steps in order, each with the matching tool, one call each, no shell:",
        "1. List the directory /tmp/sdk-capture with your ls tool.",
        "2. Find the files matching `**/*.txt` with your glob tool.",
        "3. Search for `color` with your grep tool.",
        "4. Delete old.log with your delete tool.",
        "5. Write a todo list with the items `scan` (completed) and `report` (pending) with your todo tool.",
        "Then reply with the single word done.",
      ].join("\n"),
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const calls = m.events!.filter((e) => e.kind === "tool_use");
    // No ls tool is offered: the model lists the folder with a glob.
    expect(calls.map((c) => [c.toolName, c.toolResult])).toEqual([
      ["Glob", "a.txt\nb.md\nold.log\nsub/c.txt"],
      ["Glob", "a.txt\nsub/c.txt"],
      ["Grep", "./a.txt\n./sub/c.txt"],
      ["Delete", "Deleted"],
      ["Todos", "2 todos"],
    ]);
    expect(calls[4].content).toBe("**Todos**\n- [x] scan\n- [ ] report");
  },
});
