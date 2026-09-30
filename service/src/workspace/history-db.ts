import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./workspace";

// Every workspace's messages, one row each, the Message as JSON. A save
// writes only the messages that changed: a long history is tens of
// megabytes. The search index (history-index.ts) is built from this file in
// a worker thread and can be deleted at any time; this one is the history
// itself.
export class HistoryDb {
  private db: DatabaseSync;
  // Per workspace: the hash of each message as last written, and the next
  // position. Filled on first use from the file.
  private written = new Map<string, Map<string, string>>();
  private nextSeq = new Map<string, number>();

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Before WAL mode: SQLite gives its side files the file's permissions.
    fs.chmodSync(file, 0o600);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      pragma busy_timeout = 5000;
      create table if not exists messages (
        session text not null,
        id text not null,
        seq integer not null,
        ts integer not null,
        kind text not null,
        status text not null,
        hash text not null,
        body text not null,
        primary key (session, id)
      );
      create index if not exists messages_order on messages (session, seq);
    `);
  }

  // Throws when a row cannot be parsed: an empty list would be saved over it.
  load(session: string): Message[] {
    const rows = this.db
      .prepare("select body, hash, seq from messages where session = ? order by seq")
      .all(session) as Array<{ body: string; hash: string; seq: number }>;
    const messages = rows.map((r) => JSON.parse(r.body) as Message);
    this.written.set(session, new Map(messages.map((m, i) => [m.id, rows[i].hash])));
    this.nextSeq.set(session, rows.length ? rows[rows.length - 1].seq + 1 : 0);
    return messages;
  }

  // Writes the messages in `changed` (every one, compared by content, for
  // "all"), the new ones, and drops the ones no longer listed. True when
  // anything was written.
  save(session: string, messages: Message[], changed: ReadonlySet<string> | "all"): boolean {
    const written = this.writtenOf(session);
    let seq = this.nextSeq.get(session) ?? 0;
    const insert = this.db.prepare(
      "insert into messages (session, id, seq, ts, kind, status, hash, body) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const update = this.db.prepare(
      "update messages set ts = ?, kind = ?, status = ?, hash = ?, body = ? where session = ? and id = ?",
    );
    const remove = this.db.prepare("delete from messages where session = ? and id = ?");
    let wrote = false;
    this.db.exec("begin immediate");
    try {
      for (const m of messages) {
        const had = written.get(m.id);
        if (had !== undefined && changed !== "all" && !changed.has(m.id)) continue;
        const body = JSON.stringify(m);
        const hash = createHash("sha1").update(body).digest("base64");
        if (had === hash) continue;
        if (had === undefined) {
          insert.run(session, m.id, seq++, m.timestamp, m.kind, m.status, hash, body);
        } else {
          update.run(m.timestamp, m.kind, m.status, hash, body, session, m.id);
        }
        written.set(m.id, hash);
        wrote = true;
      }
      if (written.size > messages.length || wrote) {
        const listed = new Set(messages.map((m) => m.id));
        for (const id of [...written.keys()]) {
          if (listed.has(id)) continue;
          remove.run(session, id);
          written.delete(id);
          wrote = true;
        }
      }
      this.db.exec("commit");
    } catch (e) {
      // What is cached may no longer match the file; SQLite may have rolled
      // back already (a full disk does).
      this.written.delete(session);
      this.nextSeq.delete(session);
      if (this.db.isTransaction) this.db.exec("rollback");
      throw e;
    }
    this.nextSeq.set(session, seq);
    return wrote;
  }

  delete(session: string): void {
    this.db.prepare("delete from messages where session = ?").run(session);
    this.written.delete(session);
    this.nextSeq.delete(session);
  }

  // Everything in the file itself, none left in its -wal: a copy of
  // history.db alone is then the whole history.
  checkpoint(): void {
    this.db.exec("pragma wal_checkpoint(truncate)");
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }

  private writtenOf(session: string): Map<string, string> {
    let written = this.written.get(session);
    if (!written) {
      const rows = this.db
        .prepare("select id, hash, seq from messages where session = ?")
        .all(session) as Array<{ id: string; hash: string; seq: number }>;
      written = new Map(rows.map((r) => [r.id, r.hash]));
      this.written.set(session, written);
      this.nextSeq.set(
        session,
        rows.reduce((n, r) => Math.max(n, r.seq + 1), 0),
      );
    }
    return written;
  }
}
