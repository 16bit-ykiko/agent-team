import * as fs from "fs";
import * as path from "path";
import { HistoryDb } from "./history-db";
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

// A workspace is <id>.json, what it is (name, folder, agents), and its
// messages in history.db (history-db.ts), which every workspace shares.
function metaPath(baseDir: string, id: string): string {
  return path.join(wsDir(baseDir), `${id}.json`);
}

export function historyFile(baseDir: string): string {
  return path.join(dataRoot(baseDir), CACHE_DIR, "history.db");
}

// Derived from history.db (history-index.ts); safe to delete.
export function historyIndexFile(baseDir: string): string {
  return path.join(dataRoot(baseDir), CACHE_DIR, "history-index.db");
}

const histories = new Map<string, HistoryDb>();

export function historyOf(baseDir: string): HistoryDb {
  const file = path.resolve(historyFile(baseDir));
  let db = histories.get(file);
  if (!db) {
    db = new HistoryDb(file);
    histories.set(file, db);
  }
  return db;
}

export function closeHistory(baseDir: string): void {
  const file = path.resolve(historyFile(baseDir));
  histories.get(file)?.close();
  histories.delete(file);
}

// A state without `messages` describes an unloaded (archived) workspace:
// its history stays as it is. `changed` names the messages to write (new
// and removed ones are found anyway); "all" compares every one. True when
// the history changed.
export function saveWorkspace(
  baseDir: string,
  ws: WorkspaceState,
  changed: ReadonlySet<string> | "all" = "all",
): boolean {
  const { messages, ...meta } = ws;
  const wrote = messages ? historyOf(baseDir).save(ws.id, messages, changed) : false;
  writeJson(metaPath(baseDir, ws.id), meta);
  return wrote;
}

// Throws when the history cannot be read: an empty list would be saved
// over it.
export function loadWorkspaceMessages(baseDir: string, workspaceId: string): Message[] {
  return historyOf(baseDir).load(workspaceId);
}

// The history first: a stop in between leaves a workspace to delete again,
// not rows nothing lists.
export function deleteWorkspaceState(baseDir: string, workspaceId: string): void {
  historyOf(baseDir).delete(workspaceId);
  fs.rmSync(metaPath(baseDir, workspaceId), { force: true });
  const logs = path.join(dataRoot(baseDir), LOGS_DIR, workspaceId);
  fs.rmSync(logs, { recursive: true, force: true });
  ensuredLogDirs.delete(logs);
}

export function saveIndex(baseDir: string, workspaceIds: string[]): void {
  writeJson(indexPath(baseDir), { workspaceIds });
}

export function loadAll(baseDir: string): WorkspaceState[] {
  const index = readJson<StateIndex>(indexPath(baseDir));
  if (!index) return [];

  const results: WorkspaceState[] = [];
  for (const id of index.workspaceIds) {
    const file = metaPath(baseDir, id);
    const ws = readJson<WorkspaceState>(file);
    if (!ws) continue;
    // Saved before history.db: loaded as it is, the first save would drop
    // the history.
    if (ws.messages) {
      throw new Error(`${file} still holds its messages, from before history.db`);
    }
    if (stripProviderEnv(ws)) writeJson(file, ws);
    else if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    // Archived histories stay on disk until opened.
    if (!ws.archivedAt) {
      try {
        ws.messages = loadWorkspaceMessages(baseDir, id);
      } catch (e) {
        // Left unloaded, so nothing saves an empty history over it.
        console.error(`[state] ${id}: history unreadable`, e);
      }
    }
    results.push(ws);
  }
  return results;
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
