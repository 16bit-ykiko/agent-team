import { StreamEvent } from "./useServer";

export const SUBAGENT_KINDS = new Set(["subagent_start", "subagent_progress", "subagent_done"]);
// One-line status banners that render inline rather than inside the
// collapsed step box: compaction, CLI notices, API retries.
export const BANNER_KINDS = new Set(["compact", "notice", "retry", "error"]);

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
      const prev = existing?.subagent;
      const next = e.subagent!;
      merged.set(taskId, {
        ...e,
        subagent: {
          ...(prev ?? {}),
          ...next,
          // Later lifecycle events carry only their own fields: keep what the
          // start knew (description, type, prompt) and the real inner count —
          // a summarised done event says 0, which would hide the transcript.
          description: prev?.description || next.description,
          agentType: next.agentType ?? prev?.agentType,
          prompt: next.prompt ?? prev?.prompt,
          hasPrompt: next.hasPrompt ?? prev?.hasPrompt,
          lastTool: next.lastTool ?? prev?.lastTool,
          events: prev?.events ?? next.events,
          eventCount: Math.max(prev?.eventCount ?? 0, next.eventCount ?? 0) || undefined,
        },
      });
    }
  }
  return merged;
}

// The tool_use that spawned a subagent (same toolUseId as its card) shows the
// same prompt and result as the card; the card is the richer of the two.
function spawnToolUseIds(events: StreamEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind === "subagent_start" && e.toolUseId) ids.add(e.toolUseId);
  }
  return ids;
}

function isOrdinary(e: StreamEvent, spawns: Set<string>): boolean {
  if (isSubagentEvent(e) || isBannerEvent(e)) return false;
  return !(e.kind === "tool_use" && e.toolUseId != null && spawns.has(e.toolUseId));
}

export function splitEvents(events: StreamEvent[]): {
  regular: StreamEvent[];
  subagents: StreamEvent[];
  banners: StreamEvent[];
} {
  const spawns = spawnToolUseIds(events);
  const regular = events.filter((e) => isOrdinary(e, spawns));
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
  const spawns = spawnToolUseIds(events);
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
    } else if (isOrdinary(e, spawns)) {
      // `step` is per content block, not per model step, so it is not a
      // boundary: cutting on it gave one box per thinking/tool event.
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
