import * as fs from "fs";
import * as path from "path";

interface StreamEvent {
  kind: string;
  content: string;
  raw?: unknown;
}

interface LogEntry {
  timestamp: number;
  messageId: string;
  event: StreamEvent;
}

interface Message {
  id: string;
  kind: string;
  agentId: string | null;
  content: string;
  timestamp: number;
  status: string;
  events?: StreamEvent[];
}

interface WorkspaceState {
  id: string;
  name: string;
  project: string;
  cwd: string;
  agents: unknown[];
  messages: Message[];
  createdAt: number;
}

function stripRaw(event: StreamEvent): StreamEvent {
  return { kind: event.kind, content: event.content };
}

function splitByText(msg: Message, events: StreamEvent[]): Message[] {
  const results: Message[] = [];
  let pending: StreamEvent[] = [];
  let counter = 0;

  for (const ev of events) {
    if (ev.kind === "text") {
      const newMsg: Message = {
        id: counter === 0 ? msg.id : `${msg.id}-${counter}`,
        kind: msg.kind,
        agentId: msg.agentId,
        content: ev.content,
        timestamp: msg.timestamp + counter,
        status: "done",
        events: pending,
      };
      results.push(newMsg);
      pending = [];
      counter++;
    } else {
      pending.push(stripRaw(ev));
    }
  }

  if (results.length === 0) {
    return [{ ...msg, events: pending }];
  }

  if (pending.length > 0) {
    const last = results[results.length - 1];
    last.events = [...(last.events ?? []), ...pending];
  }

  return results;
}

const baseDir = process.argv[2] || path.join(__dirname, "..");
const dataDir = path.join(baseDir, ".agent-team");
const stateFile = path.join(dataDir, "cache", "state.json");
const logsDir = path.join(dataDir, "logs");

if (!fs.existsSync(stateFile)) {
  console.error("state.json not found at", stateFile);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as {
  workspaces: WorkspaceState[];
};

let totalPatched = 0;

for (const ws of state.workspaces) {
  const logFile = path.join(logsDir, ws.id, "stream.jsonl");
  if (!fs.existsSync(logFile)) continue;

  const eventsByMsg = new Map<string, StreamEvent[]>();
  for (const line of fs.readFileSync(logFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as LogEntry;
    const arr = eventsByMsg.get(entry.messageId) ?? [];
    arr.push(entry.event);
    eventsByMsg.set(entry.messageId, arr);
  }

  const newMessages: Message[] = [];

  for (const msg of ws.messages) {
    const logEvents = eventsByMsg.get(msg.id);

    if (!logEvents || msg.kind !== "agent") {
      newMessages.push(msg);
      continue;
    }

    const hasExistingEvents = (msg.events?.length ?? 0) > 0;
    if (hasExistingEvents) {
      newMessages.push(msg);
      continue;
    }

    const split = splitByText(msg, logEvents);
    newMessages.push(...split);
    totalPatched++;
    console.log(
      `  ${ws.name}: ${msg.id} -> ${split.length} message(s) (${logEvents.length} events)`,
    );
  }

  ws.messages = newMessages;
}

const backupFile = stateFile + ".backup";
fs.copyFileSync(stateFile, backupFile);
console.log(`Backup saved to ${backupFile}`);

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log(`Patched ${totalPatched} message(s), written to ${stateFile}`);
