import { expect } from "vitest";
import { agentMessages, compact, end, fixture, send, wait } from "../fixture.ts";

export default fixture({
  description:
    "after a server restart the thread resumes in a new app-server with its history and its client-defined tools, and /compact keeps both",
  tools: [
    {
      namespace: "panel",
      name: "lookup_code",
      description: "Look up the secret code registered for a name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      reply: "The code is 4051.",
    },
  ],
  steps: [
    send("Remember the word kiwi. Reply with the single word ok."),
    wait("idle"),
    end(),
    compact(),
    wait("result"),
    send(
      "Call the panel lookup_code tool with name gamma. Then reply with the word I asked you to remember and the code, nothing else.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [first, compacted, last] = agentMessages(r);
    expect(first.content).toBe("ok");
    expect(compacted.events!.filter((e) => e.kind === "compact")).toHaveLength(1);
    expect(last.content).toBe("kiwi 4051");
    // A new process resumes the thread, whose tools and instructions codex
    // kept: neither goes in again.
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[1].sessionId).toBe(r.sessions[0].sessionId);
    const resume = r.sent.find((s) => s.method === "thread/resume");
    expect(resume?.params).toMatchObject({ threadId: r.sessions[0].sessionId });
    expect(resume?.params).not.toHaveProperty("dynamicTools");
    expect(resume?.params).not.toHaveProperty("developerInstructions");
    expect(r.sent.filter((s) => s.method === "thread/compact/start")).toHaveLength(1);
    const call = last.events!.find((e) => e.kind === "tool_use");
    expect([call?.toolName, call?.toolResult]).toEqual([
      "mcp__panel__lookup_code",
      "The code is 4051.",
    ]);
  },
});
