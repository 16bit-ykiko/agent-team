import { expect } from "vitest";
import { fixture, send, wait, end, agentMessages } from "../fixture.ts";

export default fixture({
  description: "after a restart the agent is resumed by id and remembers the first turn",
  steps: [
    send("Remember the word kiwi and reply with the single word ok. Do not use any tools."),
    wait("result"),
    end(),
    send("Which word did I ask you to remember? Reply with that word only. Do not use any tools."),
    wait("result"),
  ],
  verify(r) {
    expect(agentMessages(r).map((m) => m.content)).toEqual([
      "ok",
      "The word you asked me to remember is **kiwi**.",
    ]);
    // The restored session resumed the agent the first one created.
    const id = "agent-e4c871b7-b0c5-415e-93cd-b9e76f683e35";
    expect(r.sessions.map((s) => s.sessionId)).toEqual([id, id]);
    expect(r.sdkCalls).toEqual(["create", "send", `resume ${id}`, "send"]);
    expect(r.sessions[1].usage.turns).toBe(2);
  },
});
