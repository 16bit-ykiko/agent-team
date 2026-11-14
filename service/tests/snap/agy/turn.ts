import { expect } from "vitest";
import { agentMessages, end, fixture, send, wait } from "../fixture.ts";

export default fixture({
  description:
    "a turn of file edits, a command and a panel tool call; after a server restart the conversation and the panel's instructions resume in a new agy",
  tools: [
    {
      name: "report",
      description: "Report a line of text to the user.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      reply: "Reported.",
    },
  ],
  instructions: "The panel's code word is quokka.",
  steps: [
    send(
      "Do these steps in order, one tool call each: 1) Create the file notes.txt containing exactly the line `hello`. 2) Edit notes.txt so that `hello` becomes `world`. 3) Run the shell command `cat notes.txt` in the foreground. 4) Call the report tool of the panel MCP server with the text `checked`. Then reply with the single word notes.txt now contains, nothing else.",
    ),
    wait("idle"),
    end(),
    send(
      "Which word does notes.txt contain now, and what is the panel's code word? Answer from memory as the two words separated by a space, nothing else; use no tool.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [first, second] = agentMessages(r);
    expect(first.content.trim()).toBe("world");
    const calls = first.events!.filter((e) => e.kind === "tool_use");
    expect(calls.find((c) => c.toolName === "Bash")?.content).toContain("cat notes.txt");
    const report = calls.find((c) => c.toolName === "mcp__panel__report");
    expect(report?.toolResult).toBe("Reported.");
    // The panel's instructions, appended to agy's system prompt, hold across
    // the restart.
    expect(second.content.trim().toLowerCase()).toBe("world quokka");
    // The restarted server's agy resumes the conversation by id.
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1].sessionId).toBe(r.sessions[0].sessionId);
    expect(r.sent.filter((s) => s.method === "session/resume")).toHaveLength(1);
    // The context is agy's last usage_update (1.5.8+), not the prompt's
    // usage, which sums the turn's model calls.
    expect(first.context?.window).toBe(1048576);
    expect(first.context!.tokens).toBeLessThan(15_000);
  },
});
