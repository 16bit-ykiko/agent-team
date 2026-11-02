import { expect } from "vitest";
import { fixture, send, wait, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a custom tool that answers with an error result, as a refused panel call does",
  options: {
    local: {
      customTools: {
        report: {
          description: "Report a line of text to the user.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          execute: () => ({
            content: [{ type: "text", text: "Refused: there is no task to report on." }],
            isError: true,
          }),
        },
      },
    },
  },
  steps: [
    send(
      "Call the report tool once with the text `hi`. Then reply with exactly what it answered, nothing else.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    const call = m.events!.find((e) => e.kind === "tool_use")!;
    // An error result is a success of the call whose value says isError:
    // the text is kept, and the call reads as failed (a refused
    // finish_task must not count as a report, project/manager.ts).
    expect(call).toMatchObject({
      toolResult: "Refused: there is no task to report on.",
      toolResultIsError: true,
    });
  },
});
