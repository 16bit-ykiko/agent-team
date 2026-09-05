import * as fs from "fs";
import * as path from "path";
import { Message, WorkspaceState } from "./task";
import type { CommandInfo } from "./claude-session";

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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
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
    const existing = readJson<WorkspaceState>(file);
    state = { ...ws, messages: existing?.messages ?? [] };
  }
  writeJson(file, state);
}

export function loadWorkspaceMessages(baseDir: string, workspaceId: string): Message[] {
  const ws = readJson<WorkspaceState>(path.join(wsDir(baseDir), `${workspaceId}.json`));
  if (!ws) return [];
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
    if (stripLegacyRaw(ws) > 0) writeJson(file, ws);
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

function migrateIfNeeded(baseDir: string): WorkspaceState[] | null {
  const oldFile = path.join(dataRoot(baseDir), CACHE_DIR, "state.json");
  if (!fs.existsSync(oldFile)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(oldFile, "utf-8"));
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
