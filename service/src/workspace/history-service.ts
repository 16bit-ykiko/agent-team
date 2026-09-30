import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import {
  answer,
  HistoryIndex,
  type EntryInfo,
  type EntryText,
  type Hit,
  type IndexRequest,
  type SearchQuery,
  type SearchResult,
  type SessionRow,
  type SqlResult,
} from "./history-index";

// A question that runs longer (a heavy SQL query) is abandoned and the
// worker restarted.
const TIMEOUT_MS = 20_000;

export interface NamedSession {
  id: string;
  name: string;
}

// The search index, run in a worker thread (history-worker.js beside the
// server bundle) so neither indexing nor a slow query holds up the server.
// Without the bundle (tests, scripts) it runs in this thread.
export class HistoryService {
  private worker: Worker | null = null;
  private local: HistoryIndex | null = null;
  private waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 0;
  private notifyTimer: NodeJS.Timeout | null = null;
  private readonly workerFile = path.join(__dirname, "history-worker.js");

  constructor(
    readonly file: string,
    readonly historyFile: string,
  ) {}

  // The history changed on disk.
  changed(): void {
    if (!fs.existsSync(this.workerFile)) {
      this.local?.markDirty();
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.ensureWorker().postMessage({ changed: true });
    }, 1000);
  }

  search(query: SearchQuery): Promise<SearchResult> {
    return this.request({ type: "search", query }) as Promise<SearchResult>;
  }

  // A word of the query may be a session's name ("clice crash" finds
  // "crash" in the clice sessions); at least one must be in the entry.
  async searchNamed(
    query: Omit<SearchQuery, "sessions">,
    sessions: NamedSession[],
  ): Promise<SearchResult> {
    const limit = (query.offset ?? 0) + query.limit;
    const groups = new Map<string, { terms: string[]; sessions: string[] }>();
    for (const s of sessions) {
      const name = s.name.toLowerCase();
      const terms = query.terms.filter((t) => !name.includes(t.toLowerCase()));
      if (terms.length === 0 && query.terms.length > 0) continue;
      const key = terms.join("\n");
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { terms, sessions: [] }));
      g.sessions.push(s.id);
    }
    const results = await Promise.all(
      [...groups.values()].map((g) => this.search({ ...query, ...g, limit, offset: 0 })),
    );
    const hits: Hit[] = results
      .flatMap((r) => r.hits)
      .sort((a, b) => b.ts - a.ts || b.entry - a.entry);
    return {
      hits: hits.slice(query.offset ?? 0, limit),
      more: hits.length > limit || results.some((r) => r.more),
      pending: Math.max(0, ...results.map((r) => r.pending)),
    };
  }

  read(entry: number, from: number, count: number): Promise<EntryText | null> {
    return this.request({ type: "read", entry, from, count }) as Promise<EntryText | null>;
  }

  entries(session: string, messages: string[]): Promise<Array<EntryInfo & { head: string }>> {
    return this.request({ type: "entries", session, messages }) as Promise<
      Array<EntryInfo & { head: string }>
    >;
  }

  sql(query: string, sessions: SessionRow[], maxRows: number): Promise<SqlResult> {
    return this.request({ type: "sql", query, sessions, maxRows }) as Promise<SqlResult>;
  }

  async close(): Promise<void> {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.local?.close();
    this.local = null;
    const worker = this.worker;
    this.worker = null;
    this.fail(new Error("The history index was closed"));
    await worker?.terminate();
  }

  private request(req: IndexRequest): Promise<unknown> {
    if (!fs.existsSync(this.workerFile)) {
      try {
        this.local ??= new HistoryIndex(this.file, this.historyFile);
        return Promise.resolve(answer(this.local, req, Infinity));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`It took longer than ${TIMEOUT_MS / 1000} s and was stopped`));
        this.restart();
      }, TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      worker.postMessage({ id, req });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerFile, {
      workerData: { file: this.file, historyFile: this.historyFile },
    });
    worker.on("message", (msg: { id: number; result?: unknown; error?: string }) => {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error !== undefined) w.reject(new Error(msg.error));
      else w.resolve(msg.result);
    });
    worker.on("error", (e) => console.error("[history-index] worker failed:", e));
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.fail(new Error("The history index stopped; ask again"));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private restart(): void {
    const worker = this.worker;
    this.worker = null;
    this.fail(new Error("The history index was restarted; ask again"));
    void worker?.terminate();
  }

  private fail(error: Error): void {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    this.waiting.clear();
  }
}

// A hit of the sidebar's search: what was said in a conversation itself (a
// subagent's reply is not shown where the hit leads), with a snippet.
export interface SearchHit {
  workspaceId: string;
  workspaceName: string;
  messageId: string;
  timestamp: number;
  snippet: string;
}

const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 56;

export async function sidebarHits(
  history: HistoryService,
  query: string,
  sessions: NamedSession[],
  limit: number,
): Promise<SearchHit[]> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const { hits } = await history.searchNamed(
    { terms, kinds: ["said"], depth: "main", limit, lines: 1 },
    sessions,
  );
  return hits.map((h) => {
    const line = h.lines[0]?.text ?? "";
    const lower = line.toLowerCase();
    const at = Math.min(
      ...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0),
      line.length,
    );
    const start = Math.max(0, at - SNIPPET_BEFORE);
    const end = Math.min(line.length, at + SNIPPET_AFTER);
    return {
      workspaceId: h.session,
      workspaceName: names.get(h.session) ?? h.session,
      messageId: h.message,
      timestamp: h.ts,
      snippet: `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`,
    };
  });
}
