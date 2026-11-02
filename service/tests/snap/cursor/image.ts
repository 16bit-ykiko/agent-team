import { expect } from "vitest";
import { fixture, send, wait, RECORD_CWD, kinds, agentMessages } from "../fixture.ts";

// The prompt is the one the workspace writes for an attached image.
export default fixture({
  description:
    "an attached image reaches the model through the read tool, its bytes never in the transcript",
  files: {
    "sample.png": {
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4oKBAEmIY1TCqYfhqAABLfxAQeNDhBQAAAABJRU5ErkJggg==",
    },
  },
  steps: [
    send(
      `[User attached image(s). Use the Read tool to view:\n${RECORD_CWD}/sample.png]\n\nWhat colour is this image? Reply with one word.`,
    ),
    wait("result"),
  ],
  verify(r) {
    const [m] = agentMessages(r);
    expect(kinds(m.events!)).toEqual(["thinking", "tool_use", "thinking"]);
    expect(m.content).toBe("Red");
    expect(JSON.stringify(r.events)).not.toContain("base64");
  },
});
