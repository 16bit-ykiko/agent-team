// Replay a captured server stream log through the real client pipeline, for
// visually verifying rendering against recorded agent runs.
//
// Usage:
//   1. Pick a run: server logs live in .agent-team/logs/<workspace-id>/stream.jsonl
//      (every stream event is appended there automatically).
//   2. Copy it to webview/public/replay.jsonl
//   3. `npm run dev` in webview, open http://localhost:5173/?replay
//      and select the "Replay" workspace.
//
// Query params:
//   replay=<url>   fetch a different log file (default /replay.jsonl)
//   speed=<n>      time compression factor (default 20x)
//   maxdelay=<ms>  cap between consecutive events (default 400ms)

interface LogEntry {
  timestamp: number;
  messageId: string;
  event: Record<string, unknown>;
}

const WS_ID = "replay";
const AGENT = {
  id: "replay-agent",
  name: "Replay",
  model: "replay",
  avatar: "🎬",
  color: "#a78bfa",
  isDefault: true,
};

export async function startReplay(dispatch: (msg: Record<string, unknown>) => void): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("replay") || "/replay.jsonl";
  const speed = Number(params.get("speed")) || 20;
  const maxDelay = Number(params.get("maxdelay")) || 400;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url} (${res.status}). Copy a .agent-team/logs/<ws>/stream.jsonl to webview/public/replay.jsonl`,
    );
  }
  const entries: LogEntry[] = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip malformed lines (e.g. a truncated tail write).
    }
  }
  if (entries.length === 0) throw new Error(`No entries in ${url}`);

  dispatch({
    type: "init",
    workspaces: [
      {
        id: WS_ID,
        name: "Replay",
        project: "replay",
        hostId: "local",
        cwd: "/",
        git: null,
        pr: null,
        agents: [AGENT],
        messages: [],
        createdAt: entries[0].timestamp,
        messagesLoaded: true,
      },
    ],
    config: { projects: {}, presets: [], models: [], commands: [], hosts: {} },
    hosts: [],
    hostAvailable: false,
  });

  const seenMsgs = new Set<string>();
  let prevTs = entries[0].timestamp;
  for (const entry of entries) {
    const delay = Math.min(Math.max(0, (entry.timestamp - prevTs) / speed), maxDelay);
    prevTs = entry.timestamp;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (!seenMsgs.has(entry.messageId)) {
      // Finalize the previous message; the log has no message_done frames.
      dispatch({
        type: "new_message",
        workspaceId: WS_ID,
        message: {
          id: entry.messageId,
          kind: "agent",
          agentId: AGENT.id,
          content: "",
          timestamp: entry.timestamp,
          status: "streaming",
          events: [],
        },
      });
      seenMsgs.add(entry.messageId);
    }
    dispatch({
      type: "stream_event",
      workspaceId: WS_ID,
      messageId: entry.messageId,
      event: entry.event,
    });
  }
  console.log(`[replay] done: ${entries.length} events, ${seenMsgs.size} message(s)`);
}
