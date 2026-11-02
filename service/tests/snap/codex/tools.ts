import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description:
    "a tool the panel defines reaches the client as item/tool/call, its answer and its refusal go back to the model, and a subagent does not get it",
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
      reply: "The code is 7319.",
    },
    {
      namespace: "panel",
      name: "finish_task",
      description: "Report the task done to the lead.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
      reply: "Refused: there is no task to finish.",
      success: false,
    },
  ],
  steps: [
    send(
      "Call the panel lookup_code tool with name alpha. Then call the panel finish_task tool with the code as its summary. Then reply with exactly what finish_task answered, nothing else.",
    ),
    wait("idle"),
    send(
      "Spawn exactly one subagent and have it call the panel lookup_code tool with name beta and report the answer back. Do not call the tool yourself. Then reply with the subagent's answer only.",
    ),
    wait("idle"),
  ],
  verify(r) {
    const [direct, spawned] = agentMessages(r);
    // Declared once, as the panel namespace, with the zod shapes as JSON Schema.
    const start = r.sent.find((s) => s.method === "thread/start");
    expect(start?.params).toMatchObject({
      developerInstructions: "Panel tools of a recorded fixture.",
      dynamicTools: [{ type: "namespace", name: "panel" }],
    });
    const calls = direct.events!.filter((e) => e.kind === "tool_use");
    expect(calls.map((e) => e.toolName)).toEqual([
      "mcp__panel__lookup_code",
      "mcp__panel__finish_task",
    ]);
    expect(calls.map((e) => [e.toolResult, !!e.toolResultIsError])).toEqual([
      ["The code is 7319.", false],
      ["Refused: there is no task to finish.", true],
    ]);
    // The session's own answers, from the tool handlers.
    const answers = r.sent.filter((s) => JSON.stringify(s.result ?? {}).includes("contentItems"));
    expect(answers.map((s) => s.result)).toEqual([
      { contentItems: [{ type: "inputText", text: "The code is 7319." }], success: true },
      {
        contentItems: [{ type: "inputText", text: "Refused: there is no task to finish." }],
        success: false,
      },
    ]);
    // The subagent never had the panel tools; its work is a card.
    const card = spawned.events!.find((e) => e.kind === "subagent_start")!;
    expect(card.subagent).toMatchObject({ description: "lookup_beta", status: "completed" });
    expect(card.subagent!.summary).toContain("tools.panel__lookup_code is not a function");
    expect(spawned.events!.some((e) => e.toolName?.startsWith("mcp__panel__"))).toBe(false);
  },
});
