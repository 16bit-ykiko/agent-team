import { describe, it, expect } from "vitest";
import { agentState, isAgentActive, agentQueues, pillLabel, stateLabel } from "../src/agents";
import { AgentInfo } from "../src/useServer";

const a = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a",
  name: "A",
  model: "m",
  avatar: "x",
  color: "#fff",
  isDefault: true,
  ...over,
});

describe("agent state helpers", () => {
  it("uses the server state and falls back to the busy flag", () => {
    expect(agentState(a())).toBe("idle");
    expect(agentState(a({ busy: true }))).toBe("working");
    expect(agentState(a({ busy: true, state: "waiting" }))).toBe("waiting");
  });

  it("treats working and waiting as active, only working as queueing", () => {
    expect(isAgentActive(a({ state: "working" }))).toBe(true);
    expect(isAgentActive(a({ state: "waiting" }))).toBe(true);
    expect(isAgentActive(a({ state: "sleeping" }))).toBe(false);
    expect(agentQueues(a({ state: "working" }))).toBe(true);
    expect(agentQueues(a({ state: "waiting" }))).toBe(false);
    expect(agentQueues(a({ state: "sleeping" }))).toBe(false);
  });

  it("keeps the header pill to one word per state", () => {
    expect(pillLabel(a(), true)).toBe("online");
    expect(pillLabel(a({ state: "working", activity: "compacting context" }), true)).toBe(
      "compacting context",
    );
    expect(pillLabel(a({ state: "waiting", activity: "2 background tasks" }), true)).toBe(
      "waiting",
    );
    expect(pillLabel(a({ state: "sleeping", activity: "sleeping until 03:01 AM" }), true)).toBe(
      "sleeping",
    );
  });

  it("labels each state, preferring the activity text", () => {
    expect(stateLabel(a(), true)).toBe("online");
    expect(stateLabel(a(), false)).toBe("offline");
    expect(stateLabel(a({ state: "working" }), true)).toBe("working");
    expect(stateLabel(a({ state: "working", activity: "Bash · 3s" }), true)).toBe("Bash · 3s");
    expect(stateLabel(a({ state: "waiting" }), true)).toBe("waiting on background work");
    expect(stateLabel(a({ state: "sleeping", activity: "sleeping until 02:00" }), true)).toBe(
      "sleeping until 02:00",
    );
  });
});
