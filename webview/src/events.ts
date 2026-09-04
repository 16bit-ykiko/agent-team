import { StreamEvent } from "./useServer";

export const SUBAGENT_KINDS = new Set(["subagent_start", "subagent_progress", "subagent_done"]);
// One-line status banners that render inline rather than inside the
// collapsed step box: compaction, CLI notices, API retries.
export const BANNER_KINDS = new Set(["compact", "notice", "retry"]);

export function isSubagentEvent(e: StreamEvent): boolean {
  return SUBAGENT_KINDS.has(e.kind);
}

export function isBannerEvent(e: StreamEvent): boolean {
  return BANNER_KINDS.has(e.kind);
}

// A subagent's lifecycle arrives as separate start/progress/done events (the
// done event is appended rather than replacing the start so contentOffset
// interleaving still works). For display we fold them into one entry per
// taskId, preferring the most final event but keeping the start's description
// and accumulated inner events.
export function splitEvents(events: StreamEvent[]): {
  regular: StreamEvent[];
  subagents: StreamEvent[];
  banners: StreamEvent[];
} {
  const regular = events.filter((e) => !isSubagentEvent(e) && !isBannerEvent(e));
  const banners = events.filter(isBannerEvent);
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
  return { regular, subagents: [...merged.values()], banners };
}

// A message "still has work in flight" when any of its subagents hasn't
// reached a terminal state — the main agent may already be idle while
// background subagents keep running.
export function hasRunningSubagents(events?: StreamEvent[]): boolean {
  return !!events?.some((e) => e.kind === "subagent_start" && e.subagent?.status === "running");
}
