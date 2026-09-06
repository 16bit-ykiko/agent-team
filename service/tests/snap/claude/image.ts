import { expect } from "vitest";
import { fixture, send, wait, kinds, agentMessages, RECORD_CWD } from "../fixture.ts";

export default fixture({
  description:
    "reading an image is a plain tool call whose base64 payload never reaches the transcript",
  files: {
    "sample.png": {
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    },
  },
  steps: [
    send(
      `Read the image file ${RECORD_CWD}/sample.png with the Read tool and describe it in at most eight words.`,
    ),
    wait("idle"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    expect(r.events.filter((e) => e.kind === "notice")).toHaveLength(0);
    expect(kinds(m.events!)).toEqual(["tool_use"]);
    expect(m.content.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.events)).not.toContain("base64");
  },
});
