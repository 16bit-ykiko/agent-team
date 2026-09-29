import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";

// A project's objectives: one TOML file per objective under
// <dir>/<area>/<name>.toml, so the lead (through its tools), the user (by
// hand) and git diffs can all read them. The id is the path: "area/name".
//
// What the user decides in passing is recorded here too: what is put off
// (status "later"), what is not done at all ("dropped", with the reason, so
// it is not reopened), priorities, and which objectives need which first.

export const OBJECTIVE_STATUSES = ["active", "later", "done", "dropped"] as const;
export const PRIORITIES = ["high", "normal", "low"] as const;
export const TASK_STATES = ["todo", "doing", "review", "done", "dropped"] as const;

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  id: string;
  text: string;
  state: TaskState;
  // The worker session carrying it out.
  session?: string;
}

// A question to settle; settled once it has an outcome.
export interface Decision {
  id: string;
  question: string;
  outcome?: string;
}

export interface Objective {
  id: string;
  area: string;
  title: string;
  // What it is for, in a sentence or two.
  goal: string;
  status: ObjectiveStatus;
  priority: Priority;
  // Why it is put off or dropped, or why the priority.
  reason?: string;
  // Where things stand now (markdown).
  context?: string;
  // Objectives that must come first.
  dependsOn: string[];
  tasks: Task[];
  decisions: Decision[];
  // Worker sessions that worked on it.
  sessions: string[];
  // Background, history, links (markdown).
  notes?: string;
  updatedAt: number;
  // Filed away (finished or given up), out of the board's main view. Where
  // the file lives, not a field in it.
  archived?: boolean;
}

// A file that could not be read stays visible (and is never written over)
// until someone fixes it.
export interface BrokenObjective {
  id: string;
  error: string;
  archived?: boolean;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Archived objectives keep their id under this directory; "_" cannot start
// an area name, so it never collides with one.
const ARCHIVE = "_archive";

export function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Bad objective id "${id}": use area/name, lowercase letters, digits and -`);
  }
}

type Entry = Objective | BrokenObjective;

export class ObjectiveStore {
  private cache = new Map<string, { key: string; value: Entry }>();
  private watchers = new Map<string, fs.FSWatcher>();
  private onChange: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seen = "";
  private closed = false;

  constructor(readonly dir: string) {}

  // Every objective file, active and archived, parsed; unreadable ones as
  // BrokenObjective. Never throws for what is on disk.
  list(): Entry[] {
    const out: Entry[] = [];
    const present = new Set<string>();
    for (const { file, id, archived, badName } of this.files()) {
      let key: string;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      present.add(file);
      if (badName) {
        out.push({ id, error: "bad file name: use lowercase letters, digits and -", archived });
        continue;
      }
      const cached = this.cache.get(file);
      if (cached?.key === key) {
        out.push(cached.value);
        continue;
      }
      const value = this.read(file, id, archived);
      this.cache.set(file, { key, value });
      out.push(value);
    }
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  // The objective with this id, active or archived.
  get(id: string): Objective | undefined {
    checkId(id);
    for (const archived of [false, true]) {
      const file = this.fileOf(id, archived);
      if (!fs.existsSync(file)) continue;
      const value = this.read(file, id, archived);
      if ("error" in value) throw new Error(`${id} cannot be read: ${value.error}`);
      return value;
    }
    return undefined;
  }

  // Writes where the objective lives (archived or not); never over a file
  // that cannot be read, and never a file that would not read back.
  write(objective: Objective): void {
    checkId(objective.id);
    const archived = !!objective.archived;
    const file = this.fileOf(objective.id, archived);
    if (fs.existsSync(this.fileOf(objective.id, !archived))) {
      throw new Error(`${objective.id} is ${archived ? "active" : "archived"}; move it instead`);
    }
    if (fs.existsSync(file)) {
      const current = this.read(file, objective.id, archived);
      if ("error" in current) {
        throw new Error(`${objective.id} cannot be read (${current.error}); fix the file first`);
      }
    }
    const text = serialize(objective);
    parse(objective.id, text);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    this.cache.delete(file);
    this.settled();
  }

  // Files an objective away, or brings it back.
  move(id: string, archived: boolean): Objective {
    const o = this.get(id);
    if (!o) throw new Error(`No objective ${id}`);
    if (!!o.archived === archived) return o;
    const from = this.fileOf(id, !archived);
    const moved = { ...o, archived, updatedAt: Date.now() };
    fs.rmSync(from, { force: true });
    this.cache.delete(from);
    try {
      this.write(moved);
    } catch (e) {
      this.write(o);
      throw e;
    }
    return moved;
  }

  remove(id: string): void {
    checkId(id);
    for (const archived of [false, true]) {
      const file = this.fileOf(id, archived);
      fs.rmSync(file, { force: true });
      this.cache.delete(file);
    }
    this.settled();
  }

  // Calls `onChange` (debounced) when files change on disk by other hands;
  // the store's own writes do not echo back.
  watch(onChange: () => void): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.onChange = onChange;
    this.seen = this.signature();
    this.rewatch();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  // Recursive fs.watch on Linux follows files by inode and goes blind to a
  // file once it has been replaced (tmp + rename) twice: watch the
  // directories themselves instead.
  private rewatch(): void {
    const dirs = [this.dir, ...this.areaDirs(this.dir)];
    const archive = path.join(this.dir, ARCHIVE);
    if (fs.existsSync(archive)) dirs.push(archive, ...this.areaDirs(archive));
    for (const d of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const w = fs.watch(d, () => this.poke());
        w.on("error", () => {
          w.close();
          this.watchers.delete(d);
        });
        this.watchers.set(d, w);
      } catch {
        // Gone again; the next event rescans.
      }
    }
    for (const [d, w] of this.watchers) {
      if (!dirs.includes(d)) {
        w.close();
        this.watchers.delete(d);
      }
    }
  }

  private poke(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.closed) return;
      try {
        this.rewatch();
        const now = this.signature();
        if (now === this.seen) return;
        this.seen = now;
        this.onChange?.();
      } catch (e) {
        console.error(`[projects] ${this.dir}: change not picked up`, e);
      }
    }, 200);
  }

  // After the store's own change: what the watcher will see is known.
  private settled(): void {
    if (this.onChange) this.seen = this.signature();
  }

  private signature(): string {
    return this.files()
      .map(({ file }) => {
        try {
          const st = fs.statSync(file);
          return `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
        } catch {
          return "";
        }
      })
      .join("\n");
  }

  private fileOf(id: string, archived: boolean): string {
    return archived
      ? path.join(this.dir, ARCHIVE, `${id}.toml`)
      : path.join(this.dir, `${id}.toml`);
  }

  private areaDirs(root: string): string[] {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== ARCHIVE)
        .map((e) => path.join(root, e.name));
    } catch {
      return [];
    }
  }

  private files(): Array<{ file: string; id: string; archived: boolean; badName: boolean }> {
    const out: Array<{ file: string; id: string; archived: boolean; badName: boolean }> = [];
    const scan = (root: string, archived: boolean) => {
      for (const areaDir of this.areaDirs(root)) {
        const area = path.basename(areaDir);
        let names: string[];
        try {
          names = fs.readdirSync(areaDir);
        } catch {
          continue;
        }
        for (const f of names) {
          // Editor lock and backup files start with a dot.
          if (!f.endsWith(".toml") || f.startsWith(".")) continue;
          const name = f.slice(0, -".toml".length);
          const badName = !NAME_PATTERN.test(area) || !NAME_PATTERN.test(name);
          out.push({ file: path.join(areaDir, f), id: `${area}/${name}`, archived, badName });
        }
      }
    };
    if (fs.existsSync(this.dir)) {
      scan(this.dir, false);
      scan(path.join(this.dir, ARCHIVE), true);
    }
    return out;
  }

  private read(file: string, id: string, archived: boolean): Entry {
    try {
      const o = parse(id, fs.readFileSync(file, "utf-8"), fs.statSync(file).mtimeMs);
      return archived ? { ...o, archived } : o;
    } catch (e) {
      const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      return archived ? { id, error, archived } : { id, error };
    }
  }
}

const KEYS = new Set([
  "title",
  "goal",
  "status",
  "priority",
  "reason",
  "context",
  "depends_on",
  "sessions",
  "updated",
  "notes",
  "tasks",
  "decisions",
]);
const TASK_KEYS = new Set(["id", "text", "state", "session"]);
const DECISION_KEYS = new Set(["id", "question", "outcome"]);

export function parse(id: string, text: string, mtimeMs = Date.now()): Objective {
  const raw = TOML.parse(text) as Record<string, unknown>;
  // A misspelt key (depends = …) would otherwise vanish without a trace.
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new Error(`unknown key ${key}`);
  const str = (key: string, required = false): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === "") {
      if (required) throw new Error(`missing ${key}`);
      return undefined;
    }
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    return v;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = raw[key] ?? fallback;
    if (!allowed.includes(v as T)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  const list = (key: string): unknown[] => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v)) throw new Error(`${key} must be a list`);
    return v;
  };
  const tables = (key: string, allowed: Set<string>): Array<Record<string, unknown>> =>
    list(key).map((v, i) => {
      if (typeof v !== "object" || v === null) throw new Error(`${key} entries must be tables`);
      for (const k of Object.keys(v)) {
        if (!allowed.has(k)) throw new Error(`unknown key ${key}[${i}].${k}`);
      }
      return v as Record<string, unknown>;
    });
  const updated = raw.updated;

  const taskRows = tables("tasks", TASK_KEYS);
  const taskIds = itemIds(taskRows, "t", "tasks");
  const decisionRows = tables("decisions", DECISION_KEYS);
  const decisionIds = itemIds(decisionRows, "d", "decisions");
  return {
    id,
    area: id.split("/")[0],
    title: str("title", true)!,
    goal: str("goal", true)!,
    status: oneOf("status", OBJECTIVE_STATUSES, "active"),
    priority: oneOf("priority", PRIORITIES, "normal"),
    ...optional("reason", str("reason")),
    ...optional("context", str("context")),
    dependsOn: strings(list("depends_on"), "depends_on"),
    tasks: taskRows.map((o, i) => {
      const field = entryField(o, `tasks[${i}]`);
      const state = o.state ?? "todo";
      if (!TASK_STATES.includes(state as TaskState)) {
        throw new Error(`tasks[${i}].state must be one of ${TASK_STATES.join(", ")}`);
      }
      return {
        id: taskIds[i],
        text: field("text") ?? "",
        state: state as TaskState,
        ...optional("session", field("session")),
      };
    }),
    decisions: decisionRows.map((o, i) => {
      const field = entryField(o, `decisions[${i}]`);
      return {
        id: decisionIds[i],
        question: field("question") ?? "",
        ...optional("outcome", field("outcome")),
      };
    }),
    sessions: strings(list("sessions"), "sessions"),
    ...optional("notes", str("notes")),
    updatedAt: updated instanceof Date ? updated.getTime() : mtimeMs,
  };
}

// Item ids as written, the missing ones numbered after the highest (so an
// entry added by hand never takes another's id); duplicates are an error.
function itemIds(rows: Array<Record<string, unknown>>, prefix: string, key: string): string[] {
  const given = rows.map((r, i) => {
    const v = r.id;
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${key}[${i}].id must be a string`);
    return v;
  });
  let next = Math.max(
    0,
    ...given.map((v) => (v?.startsWith(prefix) ? Number(v.slice(1)) || 0 : 0)),
  );
  const ids = given.map((v) => v ?? `${prefix}${++next}`);
  const dup = ids.find((v, i) => ids.indexOf(v) !== i);
  if (dup) throw new Error(`${key}: id ${dup} is used twice`);
  return ids;
}

// A string field of a [[tasks]] or [[decisions]] entry; "" counts as absent.
function entryField(o: Record<string, unknown>, where: string) {
  return (key: string): string | undefined => {
    const v = o[key];
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${where}.${key} must be a string`);
    return v;
  };
}

function strings(list: unknown[], key: string): string[] {
  if (!list.every((v): v is string => typeof v === "string")) {
    throw new Error(`${key} must be a list of strings`);
  }
  return list;
}

function optional<K extends string>(key: K, v: string | undefined): Partial<Record<K, string>> {
  return v === undefined ? {} : ({ [key]: v } as Record<K, string>);
}

// Hand-written so the files stay pleasant to read and edit: multi-line text
// as """ blocks, fields in a fixed order.
export function serialize(o: Objective): string {
  const lines: string[] = [
    "# A project objective (agent-team). Edit freely; comments are not kept when the lead rewrites it.",
  ];
  const put = (key: string, v: string | undefined) => {
    if (v !== undefined && v !== "") lines.push(`${key} = ${tomlString(v)}`);
  };
  put("title", o.title);
  put("goal", o.goal);
  lines.push(`status = "${o.status}"`, `priority = "${o.priority}"`);
  put("reason", o.reason);
  lines.push(`depends_on = [${o.dependsOn.map(tomlString).join(", ")}]`);
  if (o.sessions.length) lines.push(`sessions = [${o.sessions.map(tomlString).join(", ")}]`);
  lines.push(`updated = ${new Date(o.updatedAt).toISOString()}`);
  put("context", o.context);
  put("notes", o.notes);
  for (const t of o.tasks) {
    lines.push("", "[[tasks]]", `id = ${tomlString(t.id)}`, `text = ${tomlString(t.text)}`);
    lines.push(`state = "${t.state}"`);
    if (t.session) lines.push(`session = ${tomlString(t.session)}`);
  }
  for (const d of o.decisions) {
    lines.push("", "[[decisions]]", `id = ${tomlString(d.id)}`);
    lines.push(`question = ${tomlString(d.question)}`);
    if (d.outcome) lines.push(`outcome = ${tomlString(d.outcome)}`);
  }
  return lines.join("\n") + "\n";
}

// A TOML basic string (multi-line when the text has line breaks). Lone
// surrogates cannot be encoded and become U+FFFD.
function tomlString(raw: string): string {
  const s = raw.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
  const control = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  if (!s.includes("\n")) {
    return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f\u007f]/g, control)}"`;
  }
  // Multi-line: a quote followed by two more, or the last character, would
  // close the string; escape those.
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, control)
    .replace(/"(?=""|$)/g, '\\"');
  return `"""\n${body}"""`;
}

// Dependency view over the whole set: what still blocks each objective,
// what it unblocks, prerequisites given up (dropped: they never block), and
// references to objectives that do not exist.
export interface DependencyInfo {
  blockedBy: string[];
  unblocks: string[];
  dropped: string[];
  missing: string[];
}

export function dependencies(objectives: Objective[]): Map<string, DependencyInfo> {
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const info = new Map<string, DependencyInfo>(
    objectives.map((o) => [o.id, { blockedBy: [], unblocks: [], dropped: [], missing: [] }]),
  );
  for (const o of objectives) {
    const own = info.get(o.id)!;
    for (const dep of o.dependsOn) {
      const target = byId.get(dep);
      if (!target) {
        own.missing.push(dep);
        continue;
      }
      info.get(dep)!.unblocks.push(o.id);
      if (target.status === "dropped") own.dropped.push(dep);
      else if (target.status !== "done") own.blockedBy.push(dep);
    }
  }
  return info;
}

// A chain of prerequisites leading from `start` back to itself, if any. A
// cycle elsewhere that does not pass through `start` is not its concern.
export function cycleThrough(objectives: Objective[], start: string): string[] | null {
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const path: string[] = [start];
  const visit = (id: string): boolean => {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === start) {
        path.push(dep);
        return true;
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      path.push(dep);
      if (visit(dep)) return true;
      path.pop();
    }
    return false;
  };
  return visit(start) ? path : null;
}
