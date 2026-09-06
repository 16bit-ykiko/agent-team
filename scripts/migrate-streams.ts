/**
 * Migration script: merge old chat logs + stream logs into new WorkspaceState format.
 *
 * Data sources:
 *   .agent-team/.logs/chats/{thread_id}.jsonl    — user + bot messages from Discord
 *   .agent-team/.logs/streams/{thread_id}.jsonl   — agent events (thinking, text, tool_use, result, error, usage)
 *   .agent-team/.cache/state.json                 — thread metadata (cwd, sessions)
 *   .agent-team/.cache/state_{bot}.json           — older threads' per-bot session configs
 *
 * Output:
 *   .agent-team/.cache/workspaces/{ws-id}.json    — per-workspace state files
 *   .agent-team/.cache/index.json                 — workspace index
 *   .agent-team/logs/{ws-id}/stream.jsonl         — event logs for the new system
 */

import * as fs from "fs";
import * as path from "path";

const BASE_DIR = path.resolve(process.argv[2] ?? process.cwd());
const DATA_DIR = path.join(BASE_DIR, ".agent-team");
const CHATS_DIR = path.join(DATA_DIR, ".logs", "chats");
const STREAMS_DIR = path.join(DATA_DIR, ".logs", "streams");
const CACHE_DIR = path.join(DATA_DIR, ".cache");
const WS_OUT_DIR = path.join(CACHE_DIR, "workspaces");
const LOGS_OUT_DIR = path.join(DATA_DIR, "logs");

const REAL_USER = "ykiko7";

interface ChatEntry {
  ts: string;
  thread_id: number;
  role: "user" | "bot";
  author: string;
  content: string;
}

interface StreamEntry {
  ts: string;
  thread_id: number;
  bot: string;
  kind: string;
  content: string;
}

interface ThreadMeta {
  threadId: string;
  cwd: string;
  sessions: Record<string, { model?: string; backend?: string }>;
}

interface NewStreamEvent {
  kind: string;
  content: string;
}

interface NewMessage {
  id: string;
  kind: "user" | "agent" | "system";
  agentId: string | null;
  content: string;
  timestamp: number;
  status: "done" | "error";
  events?: NewStreamEvent[];
  turnId?: string;
}

interface AgentState {
  id: string;
  name: string;
  model: string;
  avatar: string;
  color: string;
  isDefault: boolean;
  session: {
    sessionId: string | null;
    config: { cwd: string; model?: string; permissionMode?: string };
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      turns: number;
      duration_ms: number;
    };
  };
}

interface WorkspaceState {
  id: string;
  name: string;
  project: string;
  cwd: string;
  agents: AgentState[];
  messages: NewMessage[];
  createdAt: number;
}

const AGENT_STYLES: Record<string, { avatar: string; color: string }> = {
  planner: { avatar: "🌸", color: "#FFB7C5" },
  coder: { avatar: "🎵", color: "#39C5BB" },
  reviewer: { avatar: "💙", color: "#6495ED" },
  validator: { avatar: "🔥", color: "#E05A33" },
};

const CWD_TO_PROJECT: Record<string, string> = {};

function loadProjects(): void {
  try {
    const toml = fs.readFileSync(path.join(BASE_DIR, "config.toml"), "utf-8");
    for (const m of toml.matchAll(/^(\w[\w-]*)\s*=\s*"([^"]+)"/gm)) {
      CWD_TO_PROJECT[m[2]] = m[1];
    }
  } catch {
    console.warn("Could not read config.toml, project names will be derived from cwd");
  }
}

function resolveProject(cwd: string): string {
  if (CWD_TO_PROJECT[cwd]) return CWD_TO_PROJECT[cwd];
  return path.basename(cwd);
}

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${(idCounter++).toString(36).padStart(4, "0")}`;
}

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

function loadThreadMeta(): Map<string, ThreadMeta> {
  const result = new Map<string, ThreadMeta>();

  const stateFile = path.join(CACHE_DIR, "state.json");
  if (fs.existsSync(stateFile)) {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (k === "tasks") continue;
      const entry = v as Record<string, unknown>;
      if (entry.cwd) {
        result.set(k, {
          threadId: k,
          cwd: entry.cwd as string,
          sessions: (entry.sessions as Record<string, { model?: string; backend?: string }>) ?? {},
        });
      }
    }
  }

  for (const botFile of ["state_planner.json", "state_coder.json", "state_reviewer.json"]) {
    const file = path.join(CACHE_DIR, botFile);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    for (const [tid, val] of Object.entries(raw)) {
      const v = val as Record<string, unknown>;
      if (!result.has(tid) && v.cwd) {
        result.set(tid, {
          threadId: tid,
          cwd: v.cwd as string,
          sessions: {},
        });
      }
    }
  }

  return result;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/**
 * Build agent messages from stream events for a single agent turn.
 * Splits by text events (same logic as Workspace.sendMessage).
 * Returns array of messages for this turn.
 */
function buildTurnMessages(events: StreamEntry[], agentId: string, turnId: string): NewMessage[] {
  const messages: NewMessage[] = [];
  let currentMsg: NewMessage | null = null;
  let textFinalized = false;

  function ensureMsg(ts: string): NewMessage {
    if (!currentMsg) {
      currentMsg = {
        id: genId("msg"),
        kind: "agent",
        agentId,
        content: "",
        timestamp: new Date(ts).getTime(),
        status: "done",
        events: [],
        turnId,
      };
      textFinalized = false;
      messages.push(currentMsg);
    }
    return currentMsg;
  }

  for (const e of events) {
    switch (e.kind) {
      case "text": {
        const msg = ensureMsg(e.ts);
        msg.content = e.content;
        msg.status = "done";
        textFinalized = true;
        break;
      }

      case "thinking":
      case "tool_use":
      case "error": {
        if (textFinalized) {
          currentMsg = null;
          textFinalized = false;
        }
        const msg = ensureMsg(e.ts);
        msg.events!.push({ kind: e.kind, content: e.content });
        break;
      }

      case "result": {
        const msg = currentMsg as NewMessage | null;
        if (msg && !textFinalized) {
          msg.content = e.content;
          msg.status = "done";
        }
        break;
      }
    }
  }

  return messages;
}

function convertThread(
  threadId: string,
  meta: ThreadMeta,
  chatEntries: ChatEntry[],
  streamEntries: StreamEntry[],
): WorkspaceState {
  // Discover all bots from stream events
  const botNames = new Set<string>();
  for (const e of streamEntries) botNames.add(e.bot.toLowerCase());

  // Create agent entries
  const agentMap = new Map<string, AgentState>();
  let isFirst = true;
  for (const bot of botNames) {
    const style = AGENT_STYLES[bot] ?? { avatar: "⚡", color: "#888888" };
    const sessionMeta = meta.sessions[bot];
    const agent: AgentState = {
      id: genId("agent"),
      name: bot.charAt(0).toUpperCase() + bot.slice(1),
      model: sessionMeta?.model ?? "claude-opus-4-6",
      avatar: style.avatar,
      color: style.color,
      isDefault: isFirst,
      session: {
        sessionId: null,
        config: { cwd: meta.cwd, model: sessionMeta?.model, permissionMode: "bypassPermissions" },
        usage: { ...EMPTY_USAGE },
      },
    };
    agentMap.set(bot, agent);
    isFirst = false;
  }

  // Split stream events into agent turns.
  // A turn = events between two `result` boundaries, per bot.
  // We group consecutive events by bot, splitting at `result`.
  interface AgentTurn {
    bot: string;
    events: StreamEntry[];
    startTs: string;
    endTs: string;
  }

  const agentTurns: AgentTurn[] = [];
  let currentTurnBot: string | null = null;
  let currentTurnEvents: StreamEntry[] = [];

  function flushTurn(): void {
    if (currentTurnEvents.length === 0) return;
    // Filter out usage-only turns
    const meaningful = currentTurnEvents.filter((e) => e.kind !== "usage");
    if (meaningful.length > 0) {
      agentTurns.push({
        bot: currentTurnBot!,
        events: currentTurnEvents,
        startTs: currentTurnEvents[0].ts,
        endTs: currentTurnEvents[currentTurnEvents.length - 1].ts,
      });
    }
    currentTurnEvents = [];
  }

  for (const e of streamEntries) {
    const bot = e.bot.toLowerCase();

    if (e.kind === "usage") continue;

    if (bot !== currentTurnBot) {
      flushTurn();
      currentTurnBot = bot;
    }

    currentTurnEvents.push(e);

    if (e.kind === "result") {
      flushTurn();
    }
  }
  flushTurn();

  // Build user messages from chat (filter out bot echoes and bot messages)
  interface UserMsg {
    ts: number;
    content: string;
  }

  const userMessages: UserMsg[] = [];
  for (const c of chatEntries) {
    if (c.role === "user" && c.author === REAL_USER) {
      userMessages.push({
        ts: new Date(c.ts).getTime(),
        content: c.content,
      });
    }
  }

  // Merge: interleave user messages and agent turns by timestamp
  interface TimelineEntry {
    ts: number;
    type: "user" | "agent_turn";
    userMsg?: UserMsg;
    agentTurn?: AgentTurn;
  }

  const timeline: TimelineEntry[] = [];

  for (const u of userMessages) {
    timeline.push({ ts: u.ts, type: "user", userMsg: u });
  }

  for (const t of agentTurns) {
    timeline.push({
      ts: new Date(t.startTs).getTime(),
      type: "agent_turn",
      agentTurn: t,
    });
  }

  timeline.sort((a, b) => a.ts - b.ts);

  // Convert timeline to messages
  const messages: NewMessage[] = [];

  for (const entry of timeline) {
    if (entry.type === "user" && entry.userMsg) {
      messages.push({
        id: genId("msg"),
        kind: "user",
        agentId: null,
        content: entry.userMsg.content,
        timestamp: entry.userMsg.ts,
        status: "done",
      });
    } else if (entry.type === "agent_turn" && entry.agentTurn) {
      const turn = entry.agentTurn;
      const agent = agentMap.get(turn.bot);
      if (!agent) continue;

      const turnId = genId("turn");
      const turnMsgs = buildTurnMessages(turn.events, agent.id, turnId);
      messages.push(...turnMsgs);
    }
  }

  const firstTs =
    timeline.length > 0
      ? timeline[0].ts
      : chatEntries.length > 0
        ? new Date(chatEntries[0].ts).getTime()
        : Date.now();

  return {
    id: `ws-${threadId}`,
    name: `${resolveProject(meta.cwd)} #${threadId.slice(-6)}`,
    project: resolveProject(meta.cwd),
    cwd: meta.cwd,
    agents: [...agentMap.values()],
    messages,
    createdAt: firstTs,
  };
}

/**
 * Write stream.jsonl logs compatible with the new system.
 * Format: { timestamp, messageId, event: { kind, content } }
 */
function writeStreamLogs(wsId: string, messages: NewMessage[]): void {
  const dir = path.join(LOGS_OUT_DIR, wsId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "stream.jsonl");

  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg.events || msg.events.length === 0) continue;
    for (const ev of msg.events) {
      lines.push(
        JSON.stringify({
          timestamp: msg.timestamp,
          messageId: msg.id,
          event: { kind: ev.kind, content: ev.content },
        }),
      );
    }
  }

  if (lines.length > 0) {
    fs.writeFileSync(file, lines.join("\n") + "\n");
  }
}

function main(): void {
  loadProjects();

  if (!fs.existsSync(STREAMS_DIR)) {
    console.error(`No streams directory found at ${STREAMS_DIR}`);
    process.exit(1);
  }

  const threadMeta = loadThreadMeta();
  const streamFiles = fs.readdirSync(STREAMS_DIR).filter((f) => f.endsWith(".jsonl"));

  console.log(
    `Found ${streamFiles.length} stream files, ${threadMeta.size} thread metadata entries`,
  );
  console.log(`Chat logs dir: ${fs.existsSync(CHATS_DIR) ? "found" : "NOT FOUND"}`);

  fs.mkdirSync(WS_OUT_DIR, { recursive: true });

  const newIds: string[] = [];
  let migrated = 0;
  let totalMsgs = 0;
  let totalUserMsgs = 0;

  for (const file of streamFiles) {
    const threadId = file.replace(".jsonl", "");
    const wsId = `ws-${threadId}`;

    const meta = threadMeta.get(threadId) ?? {
      threadId,
      cwd: "/tmp/unknown",
      sessions: {},
    };

    const streamEntries = readJsonl<StreamEntry>(path.join(STREAMS_DIR, file));
    const chatEntries = readJsonl<ChatEntry>(path.join(CHATS_DIR, `${threadId}.jsonl`));

    if (streamEntries.length === 0 && chatEntries.length === 0) {
      console.log(`  skip ${threadId} — empty`);
      continue;
    }

    if (meta.cwd === "/tmp/unknown") {
      console.warn(`  warn ${threadId} — no metadata, using stream data only`);
    }

    const workspace = convertThread(threadId, meta, chatEntries, streamEntries);
    const userMsgCount = workspace.messages.filter((m) => m.kind === "user").length;
    const agentMsgCount = workspace.messages.filter((m) => m.kind === "agent").length;

    // Write workspace state
    fs.writeFileSync(path.join(WS_OUT_DIR, `${wsId}.json`), JSON.stringify(workspace, null, 2));

    // Write stream logs
    writeStreamLogs(wsId, workspace.messages);

    newIds.push(wsId);
    migrated++;
    totalMsgs += workspace.messages.length;
    totalUserMsgs += userMsgCount;

    console.log(
      `  migrated ${threadId} → ${wsId} ` +
        `(${userMsgCount} user + ${agentMsgCount} agent msgs, ` +
        `${workspace.agents.length} agents, project=${workspace.project})`,
    );
  }

  // Write index
  fs.writeFileSync(
    path.join(CACHE_DIR, "index.json"),
    JSON.stringify({ workspaceIds: newIds }, null, 2),
  );

  console.log(
    `\nDone. Migrated ${migrated} thread(s), ${totalMsgs} messages (${totalUserMsgs} user). ` +
      `Total workspaces: ${newIds.length}`,
  );
}

main();
