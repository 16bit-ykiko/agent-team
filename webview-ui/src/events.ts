import { StreamEvent } from "./useServer";

export const SUBAGENT_KINDS = new Set(["subagent_start", "subagent_progress", "subagent_done"]);

export function isSubagentEvent(e: StreamEvent): boolean {
  return SUBAGENT_KINDS.has(e.kind);
}

// A subagent's lifecycle arrives as separate start/progress/done events (the
// done event is appended rather than replacing the start so contentOffset
// interleaving still works). For display we fold them into one entry per
// taskId, preferring the most final event but keeping the start's description
// and accumulated inner events.
export function splitEvents(events: StreamEvent[]): {
  regular: StreamEvent[];
  subagents: StreamEvent[];
} {
  const regular = events.filter((e) => !isSubagentEvent(e));
  const merged = new Map<string, StreamEvent>();
  for (const e of events) {
    const taskId = e.subagent?.taskId;
    if (!taskId || !isSubagentEvent(e)) continue;
    const existing = merged.get(taskId);
    if (
      !existing ||
      e.kind === "subagent_done" ||
      (e.kind === "subagent_progress" && existing.kind === "subagent_start")
    ) {
      merged.set(taskId, {
        ...e,
        subagent: {
          ...(existing?.subagent ?? {}),
          ...e.subagent!,
          description: existing?.subagent?.description || e.subagent!.description,
          events: existing?.subagent?.events ?? e.subagent!.events,
        },
      });
    }
  }
  return { regular, subagents: [...merged.values()] };
}
