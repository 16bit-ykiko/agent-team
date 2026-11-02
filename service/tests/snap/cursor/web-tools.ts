import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages } from "../fixture.ts";

export default fixture({
  description: "a web search and a page fetch are tool calls with their results",
  steps: [
    send(
      "Search the web for `IANA example domain` with your web search tool, then fetch https://example.com with your web fetch tool, one call each. Reply with the page's title only.",
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    // The SDK reports web searches and fetches as nothing but a count of
    // tool requests; even run.conversation() leaves them out.
    expect(kinds(m.events!)).toEqual(["thinking", "thinking", "thinking", "thinking"]);
    expect(m.content).toContain("Example Domain");
  },
});
