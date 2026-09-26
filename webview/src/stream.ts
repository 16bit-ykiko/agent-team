import type { StreamEvent, Message, SubAgentInfo } from "./useServer";
import { SUBAGENT_KINDS } from "./events";

export interface PendingEvent {
  wsId: string;
  messageId: string;
  event: StreamEvent;
}

// Kinds that only carry streamed text and never land in `events`.
const DELTA_KINDS = new Set(["text_delta", "thinking_delta"]);

// Fold a batch of stream events into a message. Mirrors the server-side
// aggregation in task.ts so the client view converges with what gets
// persisted: tool results attach to their tool_use, subagent lifecycles fold
// onto the start event, retries update in place.
export function applyEventsToMessage(m: Message, evts: StreamEvent[]): Message {
  if (evts.length === 0) return m;
  const deltas = evts.filter((e) => DELTA_KINDS.has(e.kind));
  const regular = evts.filter((e) => !DELTA_KINDS.has(e.kind));

  let content = m.content;
  const textDelta = deltas
    .filter((e) => e.kind === "text_delta")
    .map((e) => e.content)
    .join("");
  if (textDelta) content = (content || "") + textDelta;
  const live = liveThinkingAfter(m, evts);
  const liveChanged =
    live.liveThinking !== m.liveThinking || live.liveThinkingSince !== m.liveThinkingSince;
  if (regular.length === 0) {
    return textDelta || liveChanged ? { ...withoutLiveThinking(m), content, ...live } : m;
  }

  let events = [...(m.events ?? [])];
  // Subagent starts are copied before their transcript changes, once per
  // batch: the rest are shared with the previous state or are the wire
  // objects themselves, and React may run the same batch twice (StrictMode,
  // a rebased updater). Untouched cards keep their identity for memo.
  const owned = new Set<StreamEvent>();
  const ownSubagent = (i: number): SubAgentInfo => {
    if (!owned.has(events[i])) {
      const sa = events[i].subagent!;
      events[i] = { ...events[i], subagent: { ...sa, events: sa.events && [...sa.events] } };
      owned.add(events[i]);
    }
    return events[i].subagent!;
  };

  for (const ev of regular) {
    if (ev.kind === "tool_result" && ev.toolUseId) {
      const matchIdx = events.findIndex(
        (e) => e.kind === "tool_use" && e.toolUseId === ev.toolUseId,
      );
      if (matchIdx >= 0) {
        events[matchIdx] = {
          ...events[matchIdx],
          toolResult: ev.content,
          ...(ev.isMarkdown && { toolResultIsMarkdown: true }),
        };
        continue;
      }
    }
    // Tokens of the latest thinking block (task.ts does the same).
    if (ev.kind === "thinking_tokens") {
      let idx = events.length - 1;
      while (idx >= 0 && events[idx].kind !== "thinking") idx--;
      if (idx >= 0 && events[idx].tokens == null) {
        events[idx] = { ...events[idx], tokens: ev.tokens };
      }
      continue;
    }
    if (ev.kind === "retry") {
      const idx = events.findIndex((e) => e.kind === "retry");
      if (idx >= 0) {
        events[idx] = { ...ev, contentOffset: events[idx].contentOffset };
        continue;
      }
    }
    if (ev.kind === "subagent_progress" && ev.subagent?.taskId) {
      const innerEv = (ev.subagent as unknown as Record<string, unknown>)?._innerEvent as
        StreamEvent | undefined;
      if (innerEv) {
        const startIdx = events.findIndex(
          (e) => e.kind === "subagent_start" && e.subagent?.taskId === ev.subagent?.taskId,
        );
        if (startIdx >= 0) {
          const sa = ownSubagent(startIdx);
          // A card whose transcript was never loaded: the server holds it
          // whole, a live tail here would pass for all of it.
          if (sa.events) applyInnerEvent(sa, innerEv);
          else sa.eventCount = (sa.eventCount ?? 0) + unloadedGrowth(sa, innerEv);
        }
        continue;
      }
      const idx = events.findIndex(
        (e) => e.kind === "subagent_progress" && e.subagent?.taskId === ev.subagent?.taskId,
      );
      if (idx >= 0) {
        events[idx] = ev;
        continue;
      }
    } else if (ev.kind === "subagent_done" && ev.subagent?.taskId) {
      events = events.filter(
        (e) => !(e.kind === "subagent_progress" && e.subagent?.taskId === ev.subagent?.taskId),
      );
      const startIdx = events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === ev.subagent?.taskId,
      );
      if (startIdx >= 0 && ev.subagent) {
        const start = events[startIdx].subagent!;
        // The done event carries only terminal fields (status, summary,
        // usage); an empty description there must not wipe the start's.
        events[startIdx] = {
          ...events[startIdx],
          subagent: {
            ...start,
            ...ev.subagent,
            description: start.description || ev.subagent.description,
            agentType: ev.subagent.agentType ?? start.agentType,
            prompt: ev.subagent.prompt ?? start.prompt,
            events: start.events,
          },
        };
      }
    }
    events.push(ev);
  }
  return { ...withoutLiveThinking(m), content, events, ...live };
}

type LiveThinking = Pick<Message, "liveThinking" | "liveThinkingSince">;

// The thinking block streaming in, in batch order: an empty delta opens a
// block, the next ones extend it, and the main loop moving on ends it — its
// "thinking" event, a delta carrying the block's duration (a block whose
// text is not returned gets no event), the reply's text, a tool call.
function liveThinkingAfter(m: Message, evts: StreamEvent[]): LiveThinking {
  let text = m.liveThinking;
  let since = m.liveThinkingSince;
  for (const e of evts) {
    // A background task reporting on this message is not the main loop
    // moving on.
    if (SUBAGENT_KINDS.has(e.kind)) continue;
    if (e.kind !== "thinking_delta" || e.durationMs != null) {
      text = undefined;
      since = undefined;
    } else if (text == null || !e.content) {
      text = e.content ?? "";
      since = Date.now();
    } else {
      text += e.content;
    }
  }
  return text == null ? {} : { liveThinking: text, liveThinkingSince: since };
}

export function withoutLiveThinking(m: Message): Message {
  if (m.liveThinking == null) return m;
  const { liveThinking: _text, liveThinkingSince: _since, ...rest } = m;
  return rest;
}

// How much one live inner event grows the server's copy of a transcript the
// client never loaded (the cases of applyInnerEvent), so the card's count
// tracks what loading it would show.
function unloadedGrowth(sa: SubAgentInfo, innerEv: StreamEvent): number {
  const nid = innerEv.subagent?.taskId;
  if (innerEv.kind === "tool_result") return 0;
  if (innerEv.kind === "subagent_progress" && nid) {
    if ((innerEv.subagent as unknown as Record<string, unknown>)._innerEvent) return 0;
    if (sa.liveProgress?.includes(nid)) return 0;
    sa.liveProgress = [...(sa.liveProgress ?? []), nid];
    return 1;
  }
  if (innerEv.kind === "subagent_done" && nid && sa.liveProgress?.includes(nid)) {
    sa.liveProgress = sa.liveProgress.filter((id) => id !== nid);
    return 0;
  }
  return 1;
}

function applyInnerEvent(sa: SubAgentInfo, innerEv: StreamEvent): void {
  if (!sa.events) sa.events = [];
  if (innerEv.kind === "tool_result" && innerEv.toolUseId) {
    const i = sa.events.findIndex(
      (e) => e.kind === "tool_use" && e.toolUseId === innerEv.toolUseId,
    );
    if (i >= 0) {
      sa.events[i] = { ...sa.events[i], toolResult: innerEv.content };
    } else {
      sa.events.push(innerEv);
    }
  } else if (innerEv.kind === "subagent_progress" && innerEv.subagent?.taskId) {
    const nid = innerEv.subagent.taskId;
    const nested = (innerEv.subagent as unknown as Record<string, unknown>)._innerEvent as
      StreamEvent | undefined;
    if (nested) {
      // A carrier for a nested task: apply it inside that task's own card
      // (mirrors task.ts). Without a start to hold it, it is dropped.
      const si = sa.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === nid,
      );
      if (si >= 0) {
        const child = {
          ...sa.events[si],
          subagent: {
            ...sa.events[si].subagent!,
            events: [...(sa.events[si].subagent!.events ?? [])],
          },
        };
        applyInnerEvent(child.subagent, nested);
        sa.events[si] = child;
      }
      return;
    }
    // Nested subagent progress replaces the previous progress entry for the
    // same nested task (mirrors task.ts).
    const pi = sa.events.findIndex(
      (e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid,
    );
    if (pi >= 0) sa.events[pi] = innerEv;
    else sa.events.push(innerEv);
  } else if (innerEv.kind === "subagent_done" && innerEv.subagent?.taskId) {
    const nid = innerEv.subagent.taskId;
    const pi = sa.events.findIndex(
      (e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid,
    );
    if (pi >= 0) sa.events.splice(pi, 1);
    const si = sa.events.findIndex(
      (e) => e.kind === "subagent_start" && e.subagent?.taskId === nid,
    );
    if (si >= 0) {
      sa.events[si] = {
        ...sa.events[si],
        subagent: {
          ...sa.events[si].subagent!,
          status: innerEv.subagent.status,
          summary: innerEv.subagent.summary,
          usage: innerEv.subagent.usage,
        },
      };
    }
    sa.events.push(innerEv);
  } else {
    sa.events.push(innerEv);
  }
}

// Apply a batch of pending events to every workspace it touches.
export function applyStreamBatch<W extends { id: string; messages: Message[] }>(
  workspaces: W[],
  batch: PendingEvent[],
): W[] {
  const byWs = new Map<string, Map<string, StreamEvent[]>>();
  for (const { wsId, messageId, event } of batch) {
    let byMsg = byWs.get(wsId);
    if (!byMsg) byWs.set(wsId, (byMsg = new Map<string, StreamEvent[]>()));
    const list = byMsg.get(messageId);
    if (list) list.push(event);
    else byMsg.set(messageId, [event]);
  }
  return workspaces.map((w) => {
    const byMsg = byWs.get(w.id);
    if (!byMsg) return w;
    return {
      ...w,
      messages: w.messages.map((m) => {
        const evts = byMsg.get(m.id);
        return evts ? applyEventsToMessage(m, evts) : m;
      }),
    };
  });
}

// Replace a message's events with the server's full copy while keeping any
// subagent transcripts the client already loaded (the server strips those).
export function mergeDetailEvents(
  clientEvents: StreamEvent[] | undefined,
  serverEvents: StreamEvent[],
): StreamEvent[] {
  if (!clientEvents?.length) return serverEvents;
  return serverEvents.map((serverEv) => {
    if (!serverEv.subagent?.taskId) return serverEv;
    const clientEv = clientEvents.find((e) => e.subagent?.taskId === serverEv.subagent!.taskId);
    const kept = clientEv?.subagent?.events;
    // Shorter than the server's is a live tail with a gap before it.
    if (kept?.length && kept.length >= transcriptLength(serverEv.subagent)) {
      return { ...serverEv, subagent: { ...serverEv.subagent, events: kept } };
    }
    return serverEv;
  });
}

function transcriptLength(sa: SubAgentInfo): number {
  return sa.events?.length ?? sa.eventCount ?? 0;
}

// Reconcile a freshly fetched newest page with what the client already
// holds. Used after a reconnect: anything that finished, failed or was
// removed while the socket was down is only visible in the server's copy.
// Older pages the client scrolled back to are kept; the window covered by the
// incoming page is replaced by it, message by message.
export function mergeLatestPage(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return incoming;
  const incomingIds = new Set(incoming.map((m) => m.id));
  const oldest = incoming[0].timestamp;
  const byId = new Map(existing.map((m) => [m.id, m]));
  // Older history the client paged to. A tie on the page's first timestamp
  // is still "older" when the id is not on the page (same-millisecond
  // neighbours), otherwise a reconnect would drop a loaded message. Unless
  // the page reaches back into what the client holds, more arrived while
  // away than fits on it: the two are not adjacent, and paging (which
  // continues from the oldest loaded message) would never fill the gap. A
  // message that came live before the reply must not count as reaching.
  const reaches = byId.has(incoming[0].id);
  const retained = reaches
    ? existing.filter((m) => !incomingIds.has(m.id) && m.timestamp <= oldest)
    : [];
  const page = incoming.map((next) => {
    const cur = byId.get(next.id);
    return cur ? reconcileMessage(cur, next) : next;
  });
  return [...retained, ...page];
}

// Messages whose bodies the client had (streamed live or expanded) but that
// came back from the resync as summaries. Their full events must be
// re-fetched, or what the user was reading turns into "tap to load".
export function downgradedMessageIds(existing: Message[], merged: Message[]): string[] {
  const hadBodies = new Set(
    existing.filter((m) => m.detail !== "summary" && m.events?.length).map((m) => m.id),
  );
  return merged.filter((m) => m.detail === "summary" && hadBodies.has(m.id)).map((m) => m.id);
}

const SETTLED = new Set<Message["status"]>(["done", "error"]);

// The server sends summaries; keep the client's full bodies only when the
// message is settled on both sides and its events did not move, so nothing
// the user expanded reloads. Anything still streaming when the socket dropped
// takes the server's copy — the client's events stop wherever the connection
// did — and so does a settled message whose background card finished, grew
// or was stopped by a server restart in the meantime.
function reconcileMessage(cur: Message, next: Message): Message {
  const unchanged =
    SETTLED.has(cur.status) && cur.status === next.status && sameEvents(cur.events, next.events);
  if (unchanged && cur.detail !== "summary" && cur.events?.length) {
    const { detail: _summary, ...rest } = next;
    return { ...rest, events: cur.events };
  }
  const merged = next.events
    ? { ...next, events: mergeDetailEvents(cur.events, next.events) }
    : next;
  // Still thinking on both sides: the block goes on, and so does its timer.
  if (cur.status === "streaming" && next.status === "streaming" && cur.liveThinking != null) {
    return { ...merged, liveThinking: cur.liveThinking, liveThinkingSince: cur.liveThinkingSince };
  }
  return merged;
}

function sameEvents(cur: StreamEvent[] = [], next: StreamEvent[] = []): boolean {
  return (
    cur.length === next.length &&
    next.every((n, i) => {
      const c = cur[i];
      if (c.kind !== n.kind) return false;
      if (!n.subagent) return true;
      return (
        !!c.subagent &&
        c.subagent.status === n.subagent.status &&
        transcriptLength(c.subagent) >= transcriptLength(n.subagent)
      );
    })
  );
}

// Tool name of a tool_use event. New servers tag it explicitly; older
// persisted events only carry the "**Name** ..." markdown prefix.
export function toolNameOf(ev: StreamEvent): string | null {
  if (ev.toolName) return ev.toolName;
  const m = (ev.content ?? "").match(/^\*\*([^*]+)\*\*/);
  return m ? m[1] : null;
}

// One-line summary for a tool_use row: the first line with the bold name
// stripped, so "**Read** `a.ts`" shows as "a.ts".
export function toolSummary(ev: StreamEvent): string {
  const firstLine = (ev.content ?? "").split("\n")[0] ?? "";
  return firstLine
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`/g, "")
    .trim();
}
