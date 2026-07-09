import * as fs from "fs";
import * as path from "path";
import { WorkspaceState } from "./task";

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

export function saveWorkspace(baseDir: string, ws: WorkspaceState): void {
  writeJson(path.join(wsDir(baseDir), `${ws.id}.json`), ws);
}

export function deleteWorkspaceState(baseDir: string, workspaceId: string): void {
  const file = path.join(wsDir(baseDir), `${workspaceId}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
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
    const ws = readJson<WorkspaceState>(path.join(wsDir(baseDir), `${id}.json`));
    if (ws) results.push(ws);
  }
  return results;
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
