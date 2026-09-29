import * as fs from "fs";
import * as path from "path";
import { Message, WorkspaceState } from "./workspace";
import type { CommandInfo, StreamEvent } from "../session/claude";

const DATA_DIR = ".agent-team";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const INDEX_FILE = "index.json";
const WS_DIR = "workspaces";

interface StateIndex {
  workspaceIds: string[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function dataRoot(baseDir: string): string {
  return path.join(baseDir, DATA_DIR);
}

function wsDir(baseDir: string): string {
  return path.join(dataRoot(baseDir), CACHE_DIR, WS_DIR);
}

function indexPath(baseDir: string): string {
  return path.join(dataRoot(baseDir), CACHE_DIR, INDEX_FILE);
}

let tmpCounter = 0;

function writeJson(file: string, data: unknown): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = `${file}.${process.pid}-${++tmpCounter}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

// A state without `messages` describes an unloaded (archived) workspace:
// write its metadata but keep the history already on disk.
export function saveWorkspace(baseDir: string, ws: WorkspaceState): void {
  const file = path.join(wsDir(baseDir), `${ws.id}.json`);
  let state = ws;
  if (!ws.messages) {
    let messages: Message[] = [];
    try {
      messages = (JSON.parse(fs.readFileSync(file, "utf-8")) as WorkspaceState).messages ?? [];
    } catch (e) {
      // Only a missing file means "no history"; overwriting one that failed
      // to read would replace recoverable bytes with an empty list.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[state] ${ws.id}: history unreadable, not saving`, e);
        return;
      }
    }
    state = { ...ws, messages };
  }
  writeJson(file, state);
}

// Throws when the history exists but cannot be read: an empty list would
// be saved over it.
export function loadWorkspaceMessages(baseDir: string, workspaceId: string): Message[] {
  const file = path.join(wsDir(baseDir), `${workspaceId}.json`);
  let ws: WorkspaceState;
  try {
    ws = JSON.parse(fs.readFileSync(file, "utf-8")) as WorkspaceState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  stripLegacyRaw(ws);
  return ws.messages ?? [];
}

export function deleteWorkspaceState(baseDir: string, workspaceId: string): void {
  const file = path.join(wsDir(baseDir), `${workspaceId}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const logs = path.join(dataRoot(baseDir), LOGS_DIR, workspaceId);
  fs.rmSync(logs, { recursive: true, force: true });
  ensuredLogDirs.delete(logs);
}

export function saveIndex(baseDir: string, workspaceIds: string[]): void {
  writeJson(indexPath(baseDir), { workspaceIds });
}

export function loadAll(baseDir: string): WorkspaceState[] {
  const oldState = migrateIfNeeded(baseDir);
  if (oldState) return oldState;

  const index = readJson<StateIndex>(indexPath(baseDir));
  if (!index) return [];

  const results: WorkspaceState[] = [];
  for (const id of index.workspaceIds) {
    const file = path.join(wsDir(baseDir), `${id}.json`);
    const ws = readJson<WorkspaceState>(file);
    if (!ws) continue;
    if (stripLegacyRaw(ws) + stripProviderEnv(ws) > 0) writeJson(file, ws);
    else if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    // Archived histories stay on disk until opened; holding every one of
    // them until the whole list was parsed peaked at over a gigabyte.
    if (ws.archivedAt) delete ws.messages;
    results.push(ws);
  }
  return results;
}

// Older builds stored the full SDK message on every event as `raw`, which
// made state files tens of megabytes. Drop it on load (once — the rewrite
// makes the next load clean). Returns the number of fields removed.
export function stripLegacyRaw(ws: WorkspaceState): number {
  let removed = 0;
  const strip = (events: unknown[] | undefined) => {
    for (const ev of events ?? []) {
      const e = ev as Record<string, unknown>;
      if ("raw" in e) {
        delete e.raw;
        removed++;
      }
      const sub = e.subagent as { events?: unknown[] } | undefined;
      if (sub?.events) strip(sub.events);
    }
  };
  for (const m of ws.messages ?? []) strip(m.events);
  return removed;
}

// Older builds persisted account tokens and provider keys with the agents.
function stripProviderEnv(ws: WorkspaceState): number {
  let removed = 0;
  for (const a of ws.agents ?? []) {
    if (a.session?.config && "providerEnv" in a.session.config) {
      delete a.session.config.providerEnv;
      removed++;
    }
  }
  return removed;
}

function migrateIfNeeded(baseDir: string): WorkspaceState[] | null {
  const oldFile = path.join(dataRoot(baseDir), CACHE_DIR, "state.json");
  if (!fs.existsSync(oldFile)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(oldFile, "utf-8")) as { workspaces?: unknown } | null;
    if (!raw || !Array.isArray(raw.workspaces)) return null;

    const workspaces = raw.workspaces as WorkspaceState[];
    const ids: string[] = [];

    for (const ws of workspaces) {
      saveWorkspace(baseDir, ws);
      ids.push(ws.id);
    }
    saveIndex(baseDir, ids);
    fs.unlinkSync(oldFile);
    console.log(`Migrated ${workspaces.length} workspace(s) from state.json to per-file storage`);
    return workspaces;
  } catch {
    return null;
  }
}

// Thinking fragments are live-view only: the finished block is logged, and
// so are the empty markers of a block's start and end, which date a long
// think or a stalled request.
export function isLoggedEvent(event: StreamEvent): boolean {
  return event.kind !== "thinking_delta" || !event.content;
}

// appendLog runs on every stream event; only stat the directory once per workspace.
const ensuredLogDirs = new Set<string>();

export function appendLog(baseDir: string, workspaceId: string, entry: unknown): void {
  const dir = path.join(dataRoot(baseDir), LOGS_DIR, workspaceId);
  if (!ensuredLogDirs.has(dir)) {
    ensureDir(dir);
    ensuredLogDirs.add(dir);
  }
  const file = path.join(dir, "stream.jsonl");
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

// Small runtime settings persisted outside config.toml (which stays
// user-owned): currently just the default-account override.
export interface RuntimeSettings {
  defaultAccount?: string | null;
  // Last slash-command list reported by the Claude SDK (see Server.commands).
  commands?: CommandInfo[];
}

function settingsPath(baseDir: string): string {
  return path.join(dataRoot(baseDir), CACHE_DIR, "settings.json");
}

export function loadSettings(baseDir: string): RuntimeSettings {
  return readJson<RuntimeSettings>(settingsPath(baseDir)) ?? {};
}

export function saveSettings(baseDir: string, settings: RuntimeSettings): void {
  writeJson(settingsPath(baseDir), settings);
}
