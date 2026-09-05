import type { AgentInfo, RunState } from "./useServer";

// Effective run state of an agent. Servers that predate `state` only send
// the busy flag, so derive from it.
export function agentState(a: AgentInfo): RunState {
  if (a.state) return a.state;
  return a.busy ? "working" : "idle";
}

// "Something is going on": the agent is in a turn, or background work will
// re-invoke it. Drives the sidebar pulse and the archive guard.
export function isAgentActive(a: AgentInfo): boolean {
  const s = agentState(a);
  return s === "working" || s === "waiting";
}

// Only a turn in progress makes the composer queue instead of send: waiting
// and sleeping agents accept a new prompt immediately.
export function agentQueues(a: AgentInfo): boolean {
  return agentState(a) === "working";
}

// Label for the header pill: one word per state. Working keeps its short
// activity ("compacting context"); what a sleeping agent waits for is in
// the transcript, not squeezed into the pill.
export function pillLabel(a: AgentInfo, connected: boolean): string {
  const s = agentState(a);
  if (s === "working") return a.activity ?? "working";
  if (s === "waiting") return "waiting";
  if (s === "sleeping") return "sleeping";
  return connected ? "online" : "offline";
}

// Full label for the message header: includes the activity text.
export function stateLabel(a: AgentInfo, connected: boolean): string {
  const s = agentState(a);
  if (s === "working") return a.activity ?? "working";
  if (s === "waiting") return a.activity ?? "waiting on background work";
  if (s === "sleeping") return a.activity ?? "sleeping";
  return connected ? "online" : "offline";
}
