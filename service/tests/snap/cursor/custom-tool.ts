import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a custom tool runs in our process: its call, its result and its thrown error",
  options: {
    local: {
      customTools: {
        lookup_color: {
          description: "Look up the favourite colour of a person.",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", description: "The person's name" } },
            required: ["name"],
          },
          execute(args: Record<string, unknown>) {
            if (args.name === "Bob") throw new Error("unknown person: Bob");
            return `${String(args.name)}'s favourite colour is teal.`;
          },
        },
      },
    },
  },
  steps: [
    send(
      "Use the lookup_color tool for Alice, then for Bob, one call each. Reply with Alice's colour and, for Bob, the error the tool gave.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const calls = m.events!.filter((e) => e.kind === "tool_use");
    expect(calls.map((c) => c.toolName)).toEqual([
      "mcp__custom-user-tools__lookup_color",
      "mcp__custom-user-tools__lookup_color",
    ]);
    expect(calls[0].toolResult).toBe("Alice's favourite colour is teal.");
    // A tool that throws reaches the model, not the stream: the panel's tools
    // return their errors instead (session/cursor.ts customTools).
    expect(calls[1]).toMatchObject({ toolResult: "Tool execution error", toolResultIsError: true });
    // Text after the tool calls is a paragraph of its own.
    expect(m.content).toContain("Bob.\n\n\n**Alice:** teal");
  },
});
