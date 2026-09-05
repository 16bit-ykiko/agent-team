import type { StreamEvent, Message } from "./useServer";

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
  if (regular.length === 0) return { ...m, content };

  let events = (m.events ?? []).map((e) =>
    e.subagent
      ? {
          ...e,
          subagent: {
            ...e.subagent,
            events: e.subagent.events ? [...e.subagent.events] : undefined,
          },
        }
      : e,
  );

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
        if (startIdx >= 0) applyInnerEvent(events[startIdx].subagent!, innerEv);
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
        const existingEvents = events[startIdx].subagent?.events;
        events[startIdx] = {
          ...events[startIdx],
          subagent: { ...events[startIdx].subagent!, ...ev.subagent, events: existingEvents },
        };
      }
    }
    events.push(ev);
  }
  return { ...m, content, events };
}

function applyInnerEvent(sa: NonNullable<StreamEvent["subagent"]>, innerEv: StreamEvent): void {
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
    // Nested subagent progress replaces the previous progress entry for the
    // same nested task (mirrors task.ts).
    const nid = innerEv.subagent.taskId;
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
  return workspaces.map((w) => {
    const relevant = batch.filter((e) => e.wsId === w.id);
    if (relevant.length === 0) return w;
    return {
      ...w,
      messages: w.messages.map((m) =>
        applyEventsToMessage(
          m,
          relevant.filter((e) => e.messageId === m.id).map((e) => e.event),
        ),
      ),
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
    if (clientEv?.subagent?.events?.length) {
      return { ...serverEv, subagent: { ...serverEv.subagent, events: clientEv.subagent.events } };
    }
    return serverEv;
  });
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
  const retained = existing.filter((m) => !incomingIds.has(m.id) && m.timestamp < oldest);
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
// message is settled on both sides, so nothing the user expanded reloads.
// Anything still streaming when the socket dropped takes the server's copy —
// the client's events stop wherever the connection did.
function reconcileMessage(cur: Message, next: Message): Message {
  const unchanged = SETTLED.has(cur.status) && cur.status === next.status;
  if (unchanged && cur.detail !== "summary" && cur.events?.length) {
    const { detail: _summary, ...rest } = next;
    return { ...rest, events: cur.events };
  }
  if (!next.events) return next;
  return { ...next, events: mergeDetailEvents(cur.events, next.events) };
}

// Tool name of a tool_use event. New servers tag it explicitly; older
// persisted events only carry the "**Name** ..." markdown prefix.
export function toolNameOf(ev: StreamEvent): string | null {
  if (ev.toolName) return ev.toolName;
  const m = ev.content.match(/^\*\*([^*]+)\*\*/);
  return m ? m[1] : null;
}

// One-line summary for a tool_use row: the first line with the bold name
// stripped, so "**Read** `a.ts`" shows as "a.ts".
export function toolSummary(ev: StreamEvent): string {
  const firstLine = ev.content.split("\n")[0] ?? "";
  return firstLine
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`/g, "")
    .trim();
}
