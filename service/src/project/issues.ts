import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";
import { tomlString } from "./objectives";
import { DirWatcher, filesSignature } from "./watch";

// A project's known defects, apart from the objectives: one TOML file per
// module under <dir>/<module>.toml, laid out as it reads, the module's title
// and notes on top, its issues in groups that one fix would settle together.
// A fixed issue is deleted; the call that closed it stays in the history.

export const ISSUE_STATES = ["open", "decision", "accepted"] as const;
export const EVIDENCE = ["R", "V", "H", "S", "C"] as const;

export type IssueState = (typeof ISSUE_STATES)[number];
export type Evidence = (typeof EVIDENCE)[number];

export interface Issue {
  id: string;
  // open: to fix; decision: whether it is a defect is the user's call;
  // accepted: recorded, not to be fixed.
  state: IssueState;
  // How it is known: R reproduced by a script, V confirmed by a probe, H read
  // from the code only, S still there on an earlier re-test, C another
  // agent's probe not checked here.
  evidence?: Evidence;
  tags: string[];
  // What goes wrong, how common, where in the code (markdown).
  text: string;
  objectives: string[];
}

export interface IssueGroup {
  id: string;
  title: string;
  // What its issues have in common (markdown).
  notes?: string;
  objectives: string[];
  issues: Issue[];
}

export interface IssueModule {
  id: string;
  title: string;
  notes?: string;
  objectives: string[];
  // Issues in no group, then the groups.
  issues: Issue[];
  groups: IssueGroup[];
  updatedAt: number;
}

// A file that could not be read stays visible (and is never written over)
// until someone fixes it.
export interface BrokenModule {
  id: string;
  error: string;
}

export type ModuleEntry = IssueModule | BrokenModule;

export const MODULE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const GROUP_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const ISSUE_ID_PATTERN = /^\S{1,40}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// No spaces, and what TOML can hold: a lone surrogate would be written as
// U+FFFD and come back as another id.
export function isIssueId(id: string): boolean {
  return ISSUE_ID_PATTERN.test(id) && !LONE_SURROGATE.test(id);
}

// The highest number of each day ever in use, so a closed issue's number
// is never given again.
const COUNTERS = ".ids.json";
const DATED = /^(\d\d-\d\d)#(\d+)$/;

export function checkModuleId(id: string): void {
  if (!MODULE_PATTERN.test(id)) {
    throw new Error(`Bad module "${id}": use lowercase letters, digits and -`);
  }
}

export class IssueStore {
  private cache = new Map<string, { key: string; value: ModuleEntry }>();
  private watcher: DirWatcher | null = null;

  constructor(readonly dir: string) {}

  // Every module file, parsed; unreadable ones as BrokenModule. Never throws
  // for what is on disk.
  list(): ModuleEntry[] {
    const out: ModuleEntry[] = [];
    const present = new Set<string>();
    for (const { file, id, dir } of this.files()) {
      if (dir) {
        out.push({ id, error: "a directory: module files go right in issues/" });
        continue;
      }
      let key: string;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      present.add(file);
      if (!MODULE_PATTERN.test(id)) {
        out.push({ id, error: "bad file name: use lowercase letters, digits and -" });
        continue;
      }
      const cached = this.cache.get(file);
      if (cached?.key === key) {
        out.push(cached.value);
        continue;
      }
      const value = this.read(file, id);
      this.cache.set(file, { key, value });
      out.push(value);
    }
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): IssueModule | undefined {
    checkModuleId(id);
    const file = this.fileOf(id);
    if (!fs.existsSync(file)) return undefined;
    const value = this.read(file, id);
    if ("error" in value) throw new Error(`${id} cannot be read: ${value.error}`);
    return value;
  }

  write(m: IssueModule): void {
    this.writeAll([m]);
  }

  // In this order, each checked first: never over a file that cannot be
  // read, and never a file that would not read back.
  writeAll(modules: IssueModule[]): void {
    const texts = modules.map((m) => {
      checkModuleId(m.id);
      const file = this.fileOf(m.id);
      if (fs.existsSync(file) && "error" in this.read(file, m.id)) {
        throw new Error(`${m.id} cannot be read; fix the file first`);
      }
      const text = serializeModule(m);
      parseModule(m.id, text);
      return { file, text };
    });
    try {
      for (const { file, text } of texts) {
        this.put(file, text);
        this.cache.delete(file);
      }
    } finally {
      this.watcher?.settled();
    }
  }

  remove(id: string): void {
    checkModuleId(id);
    const file = this.fileOf(id);
    fs.rmSync(file, { force: true });
    this.cache.delete(file);
    this.watcher?.settled();
  }

  // The next MM-DD#N of `day` (the server's local date), past every number
  // of that day in `taken` or ever reserved. Writes nothing: reserve() what
  // is kept.
  allocate(taken: Iterable<string>, day = new Date()): string {
    const prefix = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    let n = Number(this.counters()[prefix]) || 0;
    for (const id of taken) {
      const m = DATED.exec(id);
      if (m?.[1] === prefix) n = Math.max(n, Number(m[2]));
    }
    return `${prefix}#${n + 1}`;
  }

  // Ids that were in use: their numbers are never handed out again, even
  // once their issues are closed.
  reserve(ids: Iterable<string>): void {
    const counters = this.counters();
    let changed = false;
    for (const id of ids) {
      const m = DATED.exec(id);
      if (!m || (Number(counters[m[1]]) || 0) >= Number(m[2])) continue;
      counters[m[1]] = Number(m[2]);
      changed = true;
    }
    if (changed) this.put(path.join(this.dir, COUNTERS), JSON.stringify(counters) + "\n");
  }

  private counters(): Record<string, number> {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(this.dir, COUNTERS), "utf-8"));
      if (raw && typeof raw === "object") return raw as Record<string, number>;
    } catch {
      // None yet, or unreadable: the ids in use still count.
    }
    return {};
  }

  // The directory need not be there: the project's own is watched too.
  watch(onChange: () => void): void {
    this.watcher?.close();
    this.watcher = new DirWatcher(
      () => [path.dirname(this.dir), this.dir],
      () => filesSignature(this.files().map((f) => f.file)),
      onChange,
      this.dir,
    );
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private put(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.toml`);
  }

  // Module files, and the directories beside them (a copy one level too
  // deep) to point out.
  private files(): Array<{ file: string; id: string; dir?: boolean }> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    // Editor lock and backup files start with a dot.
    return entries
      .filter((e) => !e.name.startsWith("."))
      .flatMap((e) =>
        e.isDirectory()
          ? [{ file: path.join(this.dir, e.name), id: e.name, dir: true }]
          : e.name.endsWith(".toml")
            ? [{ file: path.join(this.dir, e.name), id: e.name.slice(0, -".toml".length) }]
            : [],
      );
  }

  private read(file: string, id: string): ModuleEntry {
    try {
      return parseModule(id, fs.readFileSync(file, "utf-8"), fs.statSync(file).mtimeMs);
    } catch (e) {
      return { id, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
    }
  }
}

const MODULE_KEYS = new Set(["title", "notes", "objectives", "updated", "issues", "groups"]);
const GROUP_KEYS = new Set(["id", "title", "notes", "objectives", "issues"]);
const ISSUE_KEYS = new Set(["id", "state", "evidence", "tags", "objectives", "text"]);

type Raw = Record<string, unknown>;

// A misspelt key (evidance = …) would otherwise vanish without a trace.
function fields(raw: Raw, allowed: Set<string>, where: string) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`unknown key ${where}${key}`);
  }
  const str = (key: string, required = false): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === "") {
      if (required) throw new Error(`missing ${where}${key}`);
      return undefined;
    }
    if (typeof v !== "string") throw new Error(`${where}${key} must be a string`);
    return v;
  };
  const strings = (key: string): string[] => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
      throw new Error(`${where}${key} must be a list of strings`);
    }
    return v;
  };
  const tables = (key: string): Raw[] => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "object" && x !== null)) {
      throw new Error(`${where}${key} must be a list of tables`);
    }
    return v as Raw[];
  };
  return { str, strings, tables };
}

function parseIssue(raw: Raw, where: string): Issue {
  const f = fields(raw, ISSUE_KEYS, where);
  const id = f.str("id", true)!;
  if (!isIssueId(id)) throw new Error(`${where}id "${id}": no spaces, at most 40`);
  const state = f.str("state") ?? "open";
  if (!ISSUE_STATES.includes(state as IssueState)) {
    throw new Error(`${where}state must be one of ${ISSUE_STATES.join(", ")}`);
  }
  const evidence = f.str("evidence");
  if (evidence !== undefined && !EVIDENCE.includes(evidence as Evidence)) {
    throw new Error(`${where}evidence must be one of ${EVIDENCE.join(", ")}`);
  }
  return {
    id,
    state: state as IssueState,
    ...(evidence !== undefined && { evidence: evidence as Evidence }),
    tags: f.strings("tags"),
    text: f.str("text", true)!,
    objectives: f.strings("objectives"),
  };
}

export function parseModule(id: string, text: string, mtimeMs = Date.now()): IssueModule {
  const raw = TOML.parse(text.replace(/^\uFEFF/, "")) as Raw;
  const f = fields(raw, MODULE_KEYS, "");
  const issues = f.tables("issues").map((r, i) => parseIssue(r, `issues[${i}].`));
  const groups = f.tables("groups").map((r, i): IssueGroup => {
    const where = `groups[${i}].`;
    const g = fields(r, GROUP_KEYS, where);
    const gid = g.str("id", true)!;
    if (!GROUP_PATTERN.test(gid)) {
      throw new Error(`${where}id "${gid}": use lowercase letters, digits, . and -`);
    }
    const notes = g.str("notes");
    return {
      id: gid,
      title: g.str("title", true)!,
      ...(notes !== undefined && { notes }),
      objectives: g.strings("objectives"),
      issues: g.tables("issues").map((x, j) => parseIssue(x, `${where}issues[${j}].`)),
    };
  });
  const dupGroup = groups.find((g, i) => groups.findIndex((x) => x.id === g.id) !== i);
  if (dupGroup) throw new Error(`group ${dupGroup.id} is there twice`);
  const ids = [...issues, ...groups.flatMap((g) => g.issues)].map((x) => x.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`issue ${dup} is there twice`);
  const notes = f.str("notes");
  const updated = raw.updated;
  return {
    id,
    title: f.str("title", true)!,
    ...(notes !== undefined && { notes }),
    objectives: f.strings("objectives"),
    issues,
    groups,
    updatedAt: updated instanceof Date ? updated.getTime() : mtimeMs,
  };
}

// Hand-written so the files read top-down like the list they replace:
// multi-line text as """ blocks, fields in a fixed order, the text last.
export function serializeModule(m: IssueModule): string {
  const lines: string[] = [
    "# A project's issues of one module (agent-team). Edit freely; comments are not kept when an agent rewrites it.",
    `title = ${tomlString(m.title)}`,
  ];
  const list = (key: string, v: string[]) => {
    if (v.length) lines.push(`${key} = [${v.map(tomlString).join(", ")}]`);
  };
  list("objectives", m.objectives);
  lines.push(`updated = ${new Date(m.updatedAt).toISOString()}`);
  if (m.notes) lines.push(`notes = ${tomlString(m.notes)}`);
  const issue = (header: string, x: Issue) => {
    lines.push("", header, `id = ${tomlString(x.id)}`);
    if (x.state !== "open") lines.push(`state = "${x.state}"`);
    if (x.evidence) lines.push(`evidence = "${x.evidence}"`);
    list("tags", x.tags);
    list("objectives", x.objectives);
    lines.push(`text = ${tomlString(x.text)}`);
  };
  for (const x of m.issues) issue("[[issues]]", x);
  for (const g of m.groups) {
    lines.push("", "[[groups]]", `id = ${tomlString(g.id)}`, `title = ${tomlString(g.title)}`);
    list("objectives", g.objectives);
    if (g.notes) lines.push(`notes = ${tomlString(g.notes)}`);
    for (const x of g.issues) issue("[[groups.issues]]", x);
  }
  return lines.join("\n") + "\n";
}

// An issue with where it sits.
export interface Located {
  issue: Issue;
  module: IssueModule;
  group?: IssueGroup;
}

export function locate(modules: ModuleEntry[]): { byId: Map<string, Located>; twice: Set<string> } {
  const byId = new Map<string, Located>();
  const twice = new Set<string>();
  for (const module of modules) {
    if ("error" in module) continue;
    const add = (issue: Issue, group?: IssueGroup) => {
      if (byId.has(issue.id)) twice.add(issue.id);
      else byId.set(issue.id, { issue, module, ...(group && { group }) });
    };
    for (const x of module.issues) add(x);
    for (const g of module.groups) for (const x of g.issues) add(x, g);
  }
  return { byId, twice };
}

// The objectives an issue is linked to: its own, its group's, its module's.
export function linkedObjectives(at: Located): string[] {
  return [
    ...new Set([...at.issue.objectives, ...(at.group?.objectives ?? []), ...at.module.objectives]),
  ];
}
