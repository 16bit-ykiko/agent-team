import * as fs from "fs";
import * as path from "path";
import { WorkspaceState } from "./task";

const DATA_DIR = ".agent-team";
const CACHE_DIR = "cache";
const LOGS_DIR = "logs";
const STATE_FILE = "state.json";

export interface AppState {
  workspaces: WorkspaceState[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function dataRoot(baseDir: string): string {
  return path.join(baseDir, DATA_DIR);
}

export function saveState(baseDir: string, state: AppState): void {
  const dir = path.join(dataRoot(baseDir), CACHE_DIR);
  ensureDir(dir);
  const file = path.join(dir, STATE_FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function loadState(baseDir: string): AppState | null {
  const file = path.join(dataRoot(baseDir), CACHE_DIR, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.workspaces)) return null;
    return data as AppState;
  } catch {
    return null;
  }
}

export function appendLog(baseDir: string, workspaceId: string, entry: unknown): void {
  const dir = path.join(dataRoot(baseDir), LOGS_DIR, workspaceId);
  ensureDir(dir);
  const file = path.join(dir, "stream.jsonl");
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}
