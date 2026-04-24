import * as fs from "fs";
import * as path from "path";
import { TaskState } from "./task";

const STATE_DIR = ".cache";
const STATE_FILE = "state.json";

export interface AppState {
  tasks: TaskState[];
}

function statePath(baseDir: string): string {
  return path.join(baseDir, STATE_DIR, STATE_FILE);
}

export function saveState(baseDir: string, state: AppState): void {
  const dir = path.join(baseDir, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = statePath(baseDir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(baseDir));
}

export function loadState(baseDir: string): AppState | null {
  const p = statePath(baseDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tasks)) return null;
    return data as AppState;
  } catch {
    return null;
  }
}
