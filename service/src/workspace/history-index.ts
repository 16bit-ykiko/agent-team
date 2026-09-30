import * as fs from "fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { StreamEvent } from "../session/claude";
import type { Message } from "./workspace";

// The search index over the history (history-db.ts): every message cut into
// entries — what was said, thinking, each tool call with its input, each
// tool's output, errors, subagents and their work — with a trigram index
// over their text, so any substring (a path, an identifier, Chinese) is
// found. Built in a worker thread (history-worker.ts); derived, so a new
// INDEX_VERSION or a deleted file just rebuilds it.
const INDEX_VERSION = 1;

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

function walk(events: StreamEvent[], depth: number, out: Entry[]): void {
  const tools = new Map<string, string | null>();
  const add = (kind: EntryKind, text: string | undefined, tool: string | null = null) => {
    if (text?.trim()) out.push({ kind, role: null, tool, depth, text });
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
        if (e.toolUseId) tools.set(e.toolUseId, tool);
        const input = e.toolInput ? JSON.stringify(e.toolInput, null, 2) : "";
        add("tool_call", [e.content, input].filter(Boolean).join("\n"), tool);
        add("tool_output", e.toolResult, tool);
        break;
      }
      case "tool_result":
        // Only kept on its own when its call was not found.
        add("tool_output", e.content, (e.toolUseId && tools.get(e.toolUseId)) || null);
        break;
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
        );
        walk(sa.events ?? [], depth + 1, out);
        break;
      }
    }
  }
}

export interface SearchQuery {
  // Every one must be in the entry: substrings, any case unless caseSensitive.
  terms: string[];
  // A JavaScript regular expression the entry must match (^ and $ at lines).
  regex?: string;
  caseSensitive?: boolean;
  kinds?: EntryKind[];
  tool?: string;
  sessions?: string[];
  since?: number;
  until?: number;
  depth?: "main" | "subagents";
  limit: number;
  offset?: number;
  // Matching lines shown per hit.
  lines?: number;
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
  lines: Array<{ n: number; text: string }>;
  // Matching lines not shown.
  moreLines: number;
}

export interface SearchResult {
  hits: Hit[];
  more: boolean;
  // Messages not indexed yet, while the index catches up.
  pending: number;
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

export interface SqlResult {
  columns: string[];
  rows: Array<Record<string, SQLOutputValue>>;
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

// The lines that hold a term (or match the pattern), grep-like; the first
// lines when the query has neither.
function matchingLines(text: string, q: SearchQuery, re: RegExp | null) {
  const all = text.split("\n");
  const max = q.lines ?? 3;
  const terms = q.caseSensitive ? q.terms : q.terms.map((t) => t.toLowerCase());
  const at = (line: string): number => {
    if (re) {
      const m = re.exec(line);
      return m ? m.index : -1;
    }
    if (terms.length === 0) return 0;
    const hay = q.caseSensitive ? line : line.toLowerCase();
    for (const t of terms) {
      const i = hay.indexOf(t);
      if (i >= 0) return i;
    }
    return -1;
  };
  const lines: Array<{ n: number; text: string }> = [];
  let count = 0;
  all.forEach((line, i) => {
    const pos = at(line);
    if (pos < 0) return;
    count++;
    if (lines.length < max) lines.push({ n: i + 1, text: clip(line, pos) });
  });
  return { lines, moreLines: count - lines.length };
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
    this.db = this.open();
  }

  private open(): DatabaseSync {
    let db = new DatabaseSync(this.file);
    // Before WAL mode: SQLite gives its side files the file's permissions.
    fs.chmodSync(this.file, 0o600);
    const version = (db.prepare("pragma user_version").get() as { user_version: number })
      .user_version;
    if (version !== INDEX_VERSION) {
      db.close();
      for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
        fs.rmSync(f, { force: true });
      }
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
          id integer primary key,
          session text not null,
          message text not null,
          ts integer not null,
          kind text not null,
          role text,
          tool text,
          depth integer not null,
          lines integer not null,
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
  }

  markDirty(): void {
    this.dirty = true;
  }

  // Indexes what changed for up to `budgetMs`; true when caught up.
  sync(budgetMs: number): boolean {
    const start = Date.now();
    if (this.dirty) {
      this.dirty = false;
      this.todo = this.changes();
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
      this.source = new DatabaseSync(this.historyFile, { readOnly: true });
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
          "insert into entries (session, message, ts, kind, role, tool, depth, lines, text) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const fts = db.prepare("insert into entries_fts (rowid, text) values (?, ?)");
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
            e.text,
          );
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
      db.exec("rollback");
      throw e;
    }
  }

  search(q: SearchQuery): SearchResult {
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
        where.push("instr(lower(e.text), ?) > 0");
        params.push(t.toLowerCase());
      }
    }
    let re: RegExp | null = null;
    if (q.regex) {
      re = new RegExp(q.regex, q.caseSensitive ? "" : "i");
      where.push(q.caseSensitive ? "regexp(?, e.text)" : "iregexp(?, e.text)");
      params.push(q.regex);
    }
    if (q.kinds?.length) {
      where.push("e.kind in (select value from json_each(?))");
      params.push(JSON.stringify(q.kinds));
    }
    if (q.tool) {
      where.push("lower(e.tool) = lower(?)");
      params.push(q.tool);
    }
    if (q.sessions) {
      where.push("e.session in (select value from json_each(?))");
      params.push(JSON.stringify(q.sessions));
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
    const rows = this.db
      .prepare(
        `select e.* from entries e ${where.length ? `where ${where.join(" and ")}` : ""}
         order by e.ts desc, e.id desc limit ? offset ?`,
      )
      .all(...params, q.limit + 1, q.offset ?? 0) as unknown as Row[];
    const more = rows.length > q.limit;
    return {
      hits: rows.slice(0, q.limit).map((r) => ({ ...info(r), ...matchingLines(r.text!, q, re) })),
      more,
      pending: this.pending,
    };
  }

  // Lines `from` (1-based) on of an entry, at most `count`.
  read(entry: number, from: number, count: number): EntryText | null {
    const r = this.db.prepare("select * from entries where id = ?").get(entry) as unknown as
      Row | undefined;
    if (!r) return null;
    const start = Math.max(1, from);
    const lines = r.text!.split("\n").slice(start - 1, start - 1 + count);
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

  // One read-only statement over the index and the history, with the
  // sessions as the panel knows them. A fresh connection each time: the
  // statement may change the connection's own state (detach, pragmas).
  sql(query: string, sessions: SessionRow[], maxRows: number): SqlResult {
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec(`attach database '${this.historyFile.replace(/'/g, "''")}' as history`);
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
      const statement = db.prepare(query);
      const rows: Array<Record<string, SQLOutputValue>> = [];
      let truncated = false;
      for (const row of statement.iterate()) {
        if (rows.length === maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      return { columns: statement.columns().map((c) => c.name), rows, truncated };
    } finally {
      db.close();
    }
  }

  close(): void {
    this.source?.close();
    this.db.close();
  }
}

export type IndexRequest =
  | { type: "search"; query: SearchQuery }
  | { type: "read"; entry: number; from: number; count: number }
  | { type: "entries"; session: string; messages: string[] }
  | { type: "sql"; query: string; sessions: SessionRow[]; maxRows: number };

// Catches up for up to `budgetMs` first, so what was just saved is found.
export function answer(index: HistoryIndex, req: IndexRequest, budgetMs: number): unknown {
  index.sync(budgetMs);
  switch (req.type) {
    case "search":
      return index.search(req.query);
    case "read":
      return index.read(req.entry, req.from, req.count);
    case "entries":
      return index.entries(req.session, req.messages);
    case "sql":
      return index.sql(req.query, req.sessions, req.maxRows);
  }
}
