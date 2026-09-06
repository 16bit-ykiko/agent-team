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
// One entry per taskId, in order of first appearance.
function foldSubagents(events: StreamEvent[]): Map<string, StreamEvent> {
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
  return merged;
}

export function splitEvents(events: StreamEvent[]): {
  regular: StreamEvent[];
  subagents: StreamEvent[];
  banners: StreamEvent[];
} {
  const regular = events.filter((e) => !isSubagentEvent(e) && !isBannerEvent(e));
  const banners = events.filter(isBannerEvent);
  return { regular, subagents: [...foldSubagents(events).values()], banners };
}

// The transcript in timeline order: runs of ordinary events become one
// collapsible step box each, and every card (a subagent, a banner) is a
// boundary that sits where it happened. A subagent sits where it started;
// its later progress/done events fold into that card.
export type TimelineBlock =
  | { kind: "steps"; events: StreamEvent[] }
  | { kind: "banner"; ev: StreamEvent }
  | { kind: "subagent"; ev: StreamEvent };

export function timelineBlocks(events: StreamEvent[]): TimelineBlock[] {
  const folded = foldSubagents(events);
  const placed = new Set<string>();
  const blocks: TimelineBlock[] = [];
  let run: StreamEvent[] = [];
  const flush = () => {
    if (run.length > 0) blocks.push({ kind: "steps", events: run });
    run = [];
  };
  for (const e of events) {
    if (isSubagentEvent(e)) {
      const taskId = e.subagent?.taskId;
      if (!taskId || placed.has(taskId)) continue;
      placed.add(taskId);
      flush();
      blocks.push({ kind: "subagent", ev: folded.get(taskId)! });
    } else if (isBannerEvent(e)) {
      flush();
      blocks.push({ kind: "banner", ev: e });
    } else {
      run.push(e);
    }
  }
  flush();
  return blocks;
}

// A message "still has work in flight" when any of its subagents hasn't
// reached a terminal state — the main agent may already be idle while
// background subagents keep running.
export function hasRunningSubagents(events?: StreamEvent[]): boolean {
  return !!events?.some((e) => e.kind === "subagent_start" && e.subagent?.status === "running");
}
