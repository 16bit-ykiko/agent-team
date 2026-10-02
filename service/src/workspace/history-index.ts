import * as fs from "fs";
import * as path from "path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { StreamEvent } from "../session/claude";
import type { Message } from "./workspace";

// The search index over the history (history-db.ts): every message cut into
// entries — what was said, thinking, each tool call, each tool's output,
// errors, subagents and their work — with a trigram index over their text,
// so any substring (a path, an identifier, Chinese) is found. Built in a
// worker thread (history-worker.ts); derived, so a new INDEX_VERSION or a
// deleted or damaged file just rebuilds it.
const INDEX_VERSION = 4;

export type EntryKind = "said" | "thinking" | "tool_call" | "tool_output" | "error" | "subagent";
export const ENTRY_KINDS: readonly EntryKind[] = [
  "said",
  "thinking",
  "tool_call",
  "tool_output",
  "error",
  "subagent",
];

export interface Entry {
  kind: EntryKind;
  // Who said it (said): user, agent, or subagent.
  role: string | null;
  tool: string | null;
  // 0 in the conversation itself, 1 and more inside subagents.
  depth: number;
  text: string;
  // A tool's output: where its call is among the message's entries.
  call?: number;
  // A tool call: from call to result; a subagent or background task: its
  // run. Only on records made since it was measured.
  durationMs?: number;
}

export function entriesOf(m: Message): Entry[] {
  const out: Entry[] = [];
  if (m.kind !== "system" && m.content.trim()) {
    out.push({ kind: "said", role: m.kind, tool: null, depth: 0, text: m.content });
  }
  walk(m.events ?? [], 0, out);
  return out;
}

function toolOf(e: StreamEvent): string | null {
  return e.toolName ?? /^\*\*([^*]+)\*\*/.exec(e.content)?.[1] ?? null;
}

// A call as its input, the command or the path first: the rendered form
// without its **Tool** heading, code fences and inline code marks (the tool
// is a column of its own). Its input is in the rendered form already.
function callText(content: string): string {
  const lines = content
    .replace(/^\*\*[^*\n]+\*\*[ \t]?/, "")
    .split("\n")
    .filter((l) => !/^\s*```[\w-]*\s*$/.test(l));
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length) lines[0] = lines[0].replace(/`([^`]*)`/g, "$1");
  return lines.join("\n");
}

// Terminal colours and cursor moves in command output.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function walk(events: StreamEvent[], depth: number, out: Entry[]): void {
  const tools = new Map<string, { tool: string | null; call: number }>();
  // Where the entry went, -1 for none.
  const add = (
    kind: EntryKind,
    text: string | undefined,
    tool: string | null = null,
    call = -1,
    durationMs?: number,
  ) => {
    if (!text?.trim()) return -1;
    out.push({
      kind,
      role: null,
      tool,
      depth,
      text,
      ...(call >= 0 && { call }),
      ...(durationMs != null && { durationMs }),
    });
    return out.length - 1;
  };
  for (const e of events) {
    switch (e.kind) {
      case "text":
        // In the conversation itself this is the message's own text.
        if (depth > 0 && e.content.trim()) {
          out.push({ kind: "said", role: "subagent", tool: null, depth, text: e.content });
        }
        break;
      case "thinking":
        add("thinking", e.content);
        break;
      case "tool_use": {
        const tool = toolOf(e);
        const call = add("tool_call", callText(e.content) || tool || "", tool, -1, e.durationMs);
        if (e.toolUseId) tools.set(e.toolUseId, { tool, call });
        add("tool_output", e.toolResult?.replace(ANSI, ""), tool, call);
        break;
      }
      case "tool_result": {
        // Only kept on its own when its call was not found.
        const of = e.toolUseId ? tools.get(e.toolUseId) : undefined;
        add("tool_output", e.content.replace(ANSI, ""), of?.tool ?? null, of?.call ?? -1);
        break;
      }
      case "error":
        add("error", e.content);
        break;
      case "subagent_start": {
        const sa = e.subagent;
        if (!sa) break;
        add(
          "subagent",
          [sa.description, sa.prompt, sa.summary].filter(Boolean).join("\n\n"),
          sa.agentType ?? null,
          -1,
          sa.durationMs,
        );
        walk(sa.events ?? [], depth + 1, out);
        break;
      }
    }
  }
}

export interface SearchQuery {
  // Every one must be in the entry: substrings (spaces allowed), any case
  // unless caseSensitive.
  terms: string[];
  // A JavaScript regular expression the entry must match (^ and $ at lines).
  regex?: string;
  caseSensitive?: boolean;
  kinds?: EntryKind[];
  // A tool's name, or the end of one after "__" (an MCP tool's).
  tool?: string;
  // Only outputs whose call holds this text (the command, the path).
  call?: string;
  sessions?: string[];
  message?: string;
  since?: number;
  until?: number;
  depth?: "main" | "subagents";
  limit: number;
  offset?: number;
  // Matching lines shown per hit, and lines of context around each.
  lines?: number;
  context?: number;
}

export interface EntryInfo {
  entry: number;
  session: string;
  message: string;
  ts: number;
  kind: EntryKind;
  role: string | null;
  tool: string | null;
  depth: number;
  lineCount: number;
}

export interface Hit extends EntryInfo {
  // `match` false: a line of context, or of an entry listed without words.
  lines: Array<{ n: number; text: string; match: boolean }>;
  // Matching lines not shown (lines, for an entry listed without words).
  moreLines: number;
  // For a tool's output: the call it answered.
  call?: { entry: number; head: string };
}

export interface SearchResult {
  hits: Hit[];
  more: boolean;
  // Messages not indexed yet, while the index catches up.
  pending: number;
  // Nothing found in the kinds asked for: how many entries of the other
  // kinds would match.
  elsewhere?: Partial<Record<EntryKind, number>>;
  // Nothing found for a tool: the tools used where it looked.
  tools?: string[];
}

export interface EntryText extends EntryInfo {
  from: number;
  lines: string[];
}

export interface SessionRow {
  id: string;
  name: string;
  cwd: string;
  project: string | null;
  role: string | null;
  created_at: number;
  last_active: number;
  archived_at: number | null;
}

export type SqlValue = string | number | null;

export interface SqlResult {
  columns: string[];
  // Blobs as "<n bytes>", big integers as numbers: plain JSON.
  rows: Array<Record<string, SqlValue>>;
  truncated: boolean;
}

interface Row {
  id: number;
  session: string;
  message: string;
  ts: number;
  kind: EntryKind;
  role: string | null;
  tool: string | null;
  depth: number;
  lines: number;
  call: number | null;
  text?: string;
}

const LINE_WIDTH = 300;

// A pattern compiled once per query, not once per row.
function regexpFunctions(db: DatabaseSync): void {
  const cache = new Map<string, RegExp>();
  const compile = (pattern: string, flags: string) => {
    const key = `${flags}/${pattern}`;
    let re = cache.get(key);
    if (!re) {
      re = new RegExp(pattern, flags);
      cache.set(key, re);
    }
    return re;
  };
  const str = (v: SQLOutputValue) =>
    v instanceof Uint8Array ? Buffer.from(v).toString() : String(v);
  const test = (flags: string) => (pattern: SQLOutputValue, text: SQLOutputValue) =>
    text != null && compile(str(pattern), flags).test(str(text)) ? 1 : 0;
  db.function("regexp", { deterministic: true }, test("m"));
  db.function("iregexp", { deterministic: true }, test("im"));
  // SQLite's lower() folds ASCII only, unless built with ICU: Node's own
  // builds are not (25.9: lower('Ü') is 'Ü').
  db.function("fold", { deterministic: true }, (v: SQLOutputValue) =>
    v == null ? null : str(v).toLowerCase(),
  );
}

function info(r: Row): EntryInfo {
  return {
    entry: r.id,
    session: r.session,
    message: r.message,
    ts: r.ts,
    kind: r.kind,
    role: r.role,
    tool: r.tool,
    depth: r.depth,
    lineCount: r.lines,
  };
}

function clip(line: string, at: number): string {
  if (line.length <= LINE_WIDTH) return line;
  const start = Math.max(0, Math.min(at - 80, line.length - LINE_WIDTH));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + LINE_WIDTH)}${start + LINE_WIDTH < line.length ? "…" : ""}`;
}

// The lines that hold a term (or match the pattern) with the context asked
// for, grep-like; the first lines when the query has neither.
function matchingLines(text: string, q: SearchQuery, re: RegExp | null) {
  const all = text.split("\n");
  const max = q.lines ?? 3;
  if (!re && q.terms.length === 0) {
    const lines = all.slice(0, max).map((l, i) => ({ n: i + 1, text: clip(l, 0), match: false }));
    return { lines, moreLines: all.length - lines.length };
  }
  const terms = q.caseSensitive ? q.terms : q.terms.map((t) => t.toLowerCase());
  // Where the pattern or a word is in the line; -1 for neither.
  const at = (line: string): number => {
    const found: number[] = [];
    const m = re?.exec(line);
    if (m) found.push(m.index);
    const hay = q.caseSensitive ? line : line.toLowerCase();
    for (const t of terms) {
      const i = hay.indexOf(t);
      if (i >= 0) found.push(i);
    }
    return found.length ? Math.min(...found) : -1;
  };
  const matches: Array<{ i: number; pos: number }> = [];
  all.forEach((line, i) => {
    const pos = at(line);
    if (pos >= 0) matches.push({ i, pos });
  });
  const shown = matches.slice(0, max);
  const context = q.context ?? 0;
  const keep = new Map<number, number>();
  for (const m of shown) {
    for (let j = Math.max(0, m.i - context); j <= Math.min(all.length - 1, m.i + context); j++) {
      if (!keep.has(j)) keep.set(j, -1);
    }
  }
  for (const m of shown) keep.set(m.i, m.pos);
  const lines = [...keep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, pos]) => ({ n: i + 1, text: clip(all[i], Math.max(pos, 0)), match: pos >= 0 }));
  return { lines, moreLines: matches.length - shown.length };
}

const MANY_SESSIONS = 20;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// The conditions of a query on `entries e`, all but the kinds when asked.
function conditions(q: SearchQuery, withKinds = true) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  // Trigrams: a word of fewer than three characters has none to look up.
  const indexed = q.terms.filter((t) => [...t].length >= 3);
  if (indexed.length) {
    where.push("e.id in (select rowid from entries_fts where entries_fts match ?)");
    params.push(indexed.map(quote).join(" "));
  }
  for (const t of q.terms) {
    if (q.caseSensitive) {
      where.push("instr(e.text, ?) > 0");
      params.push(t);
    } else if ([...t].length < 3) {
      where.push("instr(fold(e.text), ?) > 0");
      params.push(t.toLowerCase());
    }
  }
  if (q.regex) {
    where.push(q.caseSensitive ? "regexp(?, e.text)" : "iregexp(?, e.text)");
    params.push(q.regex);
  }
  if (withKinds && q.kinds?.length) {
    where.push("e.kind in (select value from json_each(?))");
    params.push(JSON.stringify(q.kinds));
  }
  if (q.tool) {
    where.push("(lower(e.tool) = lower(?) or lower(e.tool) like ? escape '\\')");
    params.push(q.tool, `%\\_\\_${escapeLike(q.tool.toLowerCase())}`);
  }
  if (q.call) {
    where.push(
      "exists (select 1 from entries c where c.id = e.call and instr(fold(c.text), ?) > 0)",
    );
    params.push(q.call.toLowerCase());
  }
  if (q.sessions) {
    // Over many sessions their index would fetch every entry of them all to
    // sort it (1.6 s for a one-letter word over the whole history): walking
    // entries_ts newest first stops at the limit instead. Over a few, the
    // index is the short way.
    const many = q.sessions.length > MANY_SESSIONS;
    where.push(`${many ? "+" : ""}e.session in (select value from json_each(?))`);
    params.push(JSON.stringify(q.sessions));
  }
  if (q.message) {
    where.push("e.message = ?");
    params.push(q.message);
  }
  if (q.since != null) {
    where.push("e.ts >= ?");
    params.push(q.since);
  }
  if (q.until != null) {
    where.push("e.ts < ?");
    params.push(q.until);
  }
  if (q.depth) where.push(q.depth === "main" ? "e.depth = 0" : "e.depth > 0");
  return { where: where.length ? `where ${where.join(" and ")}` : "", params };
}

export class HistoryIndex {
  private db: DatabaseSync;
  private source: DatabaseSync | null = null;
  // Set when the history changed; the next sync compares the two files.
  private dirty = true;
  private todo: Array<{ session: string; message: string }> = [];

  constructor(
    readonly file: string,
    readonly historyFile: string,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.db = this.open();
    } catch (e) {
      console.error("[history-index] rebuilding an unreadable index:", e);
      this.remove();
      this.db = this.open();
    }
  }

  private remove(): void {
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      fs.rmSync(f, { force: true });
    }
  }

  private open(): DatabaseSync {
    let db = new DatabaseSync(this.file);
    // Before WAL mode: SQLite gives its side files the file's permissions.
    fs.chmodSync(this.file, 0o600);
    try {
      const { user_version } = db.prepare("pragma user_version").get() as {
        user_version: number;
      };
      if (user_version === INDEX_VERSION) {
        db.prepare("select count(*) from docs").get();
      } else {
        db.close();
        this.remove();
        db = new DatabaseSync(this.file);
        fs.chmodSync(this.file, 0o600);
        db.exec(`
          pragma journal_mode = wal;
          create table docs (
            session text not null,
            message text not null,
            hash text not null,
            primary key (session, message)
          );
          create table entries (
            id integer primary key autoincrement,
            session text not null,
            message text not null,
            ts integer not null,
            kind text not null,
            role text,
            tool text,
            depth integer not null,
            lines integer not null,
            call integer,
            duration_ms integer,
            text text not null
          );
          create index entries_message on entries (session, message);
          create index entries_ts on entries (ts);
          create virtual table entries_fts using fts5 (
            text, content = '', contentless_delete = 1, tokenize = 'trigram'
          );
          pragma user_version = ${INDEX_VERSION};
        `);
      }
      db.exec("pragma busy_timeout = 5000");
      regexpFunctions(db);
      return db;
    } catch (e) {
      if (db.isOpen) db.close();
      throw e;
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  // Indexes what changed for up to `budgetMs`; true when caught up.
  sync(budgetMs: number): boolean {
    const start = Date.now();
    if (this.dirty) {
      this.dirty = false;
      try {
        this.todo = this.changes();
      } catch (e) {
        this.dirty = true;
        throw e;
      }
    }
    while (this.todo.length && Date.now() - start < budgetMs) {
      const { session, message } = this.todo.shift()!;
      try {
        this.indexMessage(session, message);
      } catch (e) {
        console.error(`[history-index] ${session} ${message}:`, e);
      }
    }
    return this.todo.length === 0;
  }

  get pending(): number {
    return this.todo.length + (this.dirty ? 1 : 0);
  }

  // Final messages whose text is not indexed as it is now, and indexed ones
  // no longer in the history. A message still being written waits.
  private changes(): Array<{ session: string; message: string }> {
    const source = this.openSource();
    if (!source) return [];
    const key = (s: string, m: string) => `${s}\n${m}`;
    const indexed = new Map(
      (
        this.db.prepare("select session, message, hash from docs").all() as Array<{
          session: string;
          message: string;
          hash: string;
        }>
      ).map((d) => [key(d.session, d.message), d.hash]),
    );
    const out: Array<{ session: string; message: string }> = [];
    const present = new Set<string>();
    for (const r of source
      .prepare("select session, id, hash, status from messages order by session, seq")
      .all() as Array<{ session: string; id: string; hash: string; status: string }>) {
      const k = key(r.session, r.id);
      present.add(k);
      if (r.status === "streaming" || r.status === "queued") continue;
      if (indexed.get(k) !== r.hash) out.push({ session: r.session, message: r.id });
    }
    for (const k of indexed.keys()) {
      if (present.has(k)) continue;
      const [session, message] = k.split("\n");
      out.push({ session, message });
    }
    return out;
  }

  private openSource(): DatabaseSync | null {
    if (!this.source && fs.existsSync(this.historyFile)) {
      this.source = new DatabaseSync(this.historyFile, { readOnly: true, timeout: 5000 });
    }
    return this.source;
  }

  private indexMessage(session: string, message: string): void {
    const row = this.openSource()
      ?.prepare("select body, hash, ts from messages where session = ? and id = ?")
      .get(session, message) as { body: string; hash: string; ts: number } | undefined;
    const entries = row ? entriesOf(JSON.parse(row.body) as Message) : [];
    const db = this.db;
    db.exec("begin immediate");
    try {
      db.prepare(
        "delete from entries_fts where rowid in (select id from entries where session = ? and message = ?)",
      ).run(session, message);
      db.prepare("delete from entries where session = ? and message = ?").run(session, message);
      if (row) {
        const insert = db.prepare(
          "insert into entries (session, message, ts, kind, role, tool, depth, lines, call, duration_ms, text) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const fts = db.prepare("insert into entries_fts (rowid, text) values (?, ?)");
        const ids: Array<number | bigint> = [];
        for (const e of entries) {
          const lines = e.text.split("\n").length;
          const { lastInsertRowid } = insert.run(
            session,
            message,
            row.ts,
            e.kind,
            e.role,
            e.tool,
            e.depth,
            lines,
            e.call !== undefined ? ids[e.call] : null,
            e.durationMs ?? null,
            e.text,
          );
          ids.push(lastInsertRowid);
          fts.run(lastInsertRowid, e.text);
        }
        db.prepare("insert or replace into docs (session, message, hash) values (?, ?, ?)").run(
          session,
          message,
          row.hash,
        );
      } else {
        db.prepare("delete from docs where session = ? and message = ?").run(session, message);
      }
      db.exec("commit");
    } catch (e) {
      if (db.isTransaction) db.exec("rollback");
      throw e;
    }
  }

  search(q: SearchQuery): SearchResult {
    const re = q.regex ? new RegExp(q.regex, q.caseSensitive ? "" : "i") : null;
    const { where, params } = conditions(q);
    const rows = this.db
      .prepare(`select e.* from entries e ${where} order by e.ts desc, e.id desc limit ? offset ?`)
      .all(...params, q.limit + 1, q.offset ?? 0) as unknown as Row[];
    const callOf = this.db.prepare("select id, text from entries where id = ?");
    const hits = rows.slice(0, q.limit).map((r): Hit => {
      const hit: Hit = { ...info(r), ...matchingLines(r.text!, q, re) };
      if (r.call != null) {
        const call = callOf.get(r.call) as { id: number; text: string } | undefined;
        if (call) hit.call = { entry: call.id, head: call.text.split("\n")[0].slice(0, 160) };
      }
      return hit;
    });
    const result: SearchResult = { hits, more: rows.length > q.limit, pending: this.pending };
    if (hits.length === 0 && !q.offset) {
      if (q.kinds?.length && q.kinds.length < ENTRY_KINDS.length) {
        const all = conditions(q, false);
        const counts = this.db
          .prepare(`select e.kind, count(*) as n from entries e ${all.where} group by e.kind`)
          .all(...all.params) as Array<{ kind: EntryKind; n: number }>;
        const elsewhere = counts.filter((c) => !q.kinds!.includes(c.kind));
        if (elsewhere.length)
          result.elsewhere = Object.fromEntries(elsewhere.map((c) => [c.kind, c.n]));
      }
      if (q.tool) {
        const scope = conditions({ terms: [], limit: 0, sessions: q.sessions });
        result.tools = (
          this.db
            .prepare(
              `select e.tool, count(*) as n from entries e ${scope.where}
               ${scope.where ? "and" : "where"} e.tool is not null
               group by e.tool order by n desc limit 40`,
            )
            .all(...scope.params) as Array<{ tool: string }>
        ).map((t) => t.tool);
      }
    }
    return result;
  }

  // Lines `from` (1-based) on of an entry, at most `count`; the first of
  // them from its character `fromChar` on.
  read(entry: number, from: number, count: number, fromChar = 0): EntryText | null {
    const r = this.db.prepare("select * from entries where id = ?").get(entry) as unknown as
      Row | undefined;
    if (!r) return null;
    const start = Math.max(1, from);
    const lines = r.text!.split("\n").slice(start - 1, start - 1 + count);
    if (lines.length && fromChar > 0) lines[0] = lines[0].slice(fromChar);
    return { ...info(r), from: start, lines };
  }

  // The entries of these messages, in order, without their text.
  entries(session: string, messages: string[]): Array<EntryInfo & { head: string }> {
    const rows = this.db
      .prepare(
        `select id, session, message, ts, kind, role, tool, depth, lines,
           substr(text, 1, 200) as head
         from entries where session = ? and message in (select value from json_each(?))
         order by id`,
      )
      .all(session, JSON.stringify(messages)) as unknown as Array<Row & { head: string }>;
    return rows.map((r) => ({ ...info(r), head: r.head.split("\n")[0] }));
  }

  close(): void {
    this.source?.close();
    this.db.close();
  }
}

// One read-only statement over the index and the history, as far as the
// sessions given reach: `entries` and `messages` are views of theirs. A
// fresh connection each time, the statement may change its state (detach,
// pragmas); and outside the index's own, so it can be run in a process that
// is killed when it takes too long (history-service.ts).
export function querySql(
  file: string,
  historyFile: string,
  query: string,
  sessions: SessionRow[],
  maxRows: number,
): SqlResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(`attach database '${historyFile.replace(/'/g, "''")}' as history`);
    regexpFunctions(db);
    db.exec(`create temp table sessions (
      id text primary key, name text, cwd text, project text, role text,
      created_at integer, last_active integer, archived_at integer)`);
    const insert = db.prepare("insert into temp.sessions values (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const s of sessions) {
      insert.run(
        s.id,
        s.name,
        s.cwd,
        s.project,
        s.role,
        s.created_at,
        s.last_active,
        s.archived_at,
      );
    }
    db.exec(`
      create temp view entries as
        select * from main.entries where session in (select id from temp.sessions);
      create temp view messages as
        select * from history.messages where session in (select id from temp.sessions);
    `);
    const statement = db.prepare(query);
    const plain = (v: SQLOutputValue): SqlValue =>
      v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === "bigint" ? Number(v) : v;
    const rows: Array<Record<string, SqlValue>> = [];
    let truncated = false;
    for (const row of statement.iterate()) {
      if (rows.length === maxRows) {
        truncated = true;
        break;
      }
      rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])));
    }
    return { columns: statement.columns().map((c) => c.name), rows, truncated };
  } finally {
    db.close();
  }
}

export interface SqlRequest {
  query: string;
  sessions: SessionRow[];
  maxRows: number;
}

export type IndexRequest =
  | { type: "search"; query: SearchQuery }
  | { type: "read"; entry: number; from: number; count: number; fromChar?: number }
  | { type: "entries"; session: string; messages: string[] }
  | ({ type: "sql" } & SqlRequest);

// Catches up for up to `budgetMs` first, so what was just saved is found.
export function answer(index: HistoryIndex, req: IndexRequest, budgetMs: number): unknown {
  index.sync(budgetMs);
  switch (req.type) {
    case "search":
      return index.search(req.query);
    case "read":
      return index.read(req.entry, req.from, req.count, req.fromChar);
    case "entries":
      return index.entries(req.session, req.messages);
    case "sql":
      return querySql(index.file, index.historyFile, req.query, req.sessions, req.maxRows);
  }
}
