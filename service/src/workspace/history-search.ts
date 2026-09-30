import { spawn } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { searchMessages, type SearchHit } from "./search";
import type { Message } from "./workspace";

export interface StoredHistory {
  id: string;
  name: string;
  // Its history file: one message per line (workspace/state.ts).
  file: string;
}

export interface StoredSearch {
  limit: number;
  // Also in what tools returned (command output, files read), not only in
  // what was said.
  toolOutput?: boolean;
}

// Saved histories searched with ripgrep: it finds the lines holding any of
// the query's words, a line being one message, and only those lines are
// parsed and checked for every word (a word may also be the history's
// name, so no single word has to be in the line). Without rg, each history
// is read in turn. Newest first.
export async function searchStored(
  histories: StoredHistory[],
  query: string,
  opts: StoredSearch,
): Promise<SearchHit[]> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const present = histories.filter((h) => fs.existsSync(h.file));
  if (terms.length === 0 || present.length === 0) return [];
  const hits =
    (await ripgrep(present, terms, query, opts)) ?? (await readAll(present, query, opts));
  return hits.sort((a, b) => b.timestamp - a.timestamp).slice(0, opts.limit);
}

// A message's hit for the query, in what was said or, when asked, in what
// its tools returned.
function hitIn(h: StoredHistory, m: Message, query: string, toolOutput: boolean): SearchHit | null {
  const [said] = searchMessages([{ id: h.id, name: h.name, messages: [m] }], query, 1);
  if (said || !toolOutput) return said ?? null;
  const tools = (m.events ?? [])
    .filter((e) => e.kind === "tool_use" || e.kind === "tool_result")
    .map((e) => [e.content, e.toolResult].filter(Boolean).join("\n"))
    .join("\n");
  const [ran] = searchMessages(
    [{ id: h.id, name: h.name, messages: [{ ...m, kind: "agent", content: tools }] }],
    query,
    1,
  );
  return ran ? { ...ran, snippet: `[tool] ${ran.snippet}` } : null;
}

// Null when rg cannot be run.
function ripgrep(
  histories: StoredHistory[],
  terms: string[],
  query: string,
  opts: StoredSearch,
): Promise<SearchHit[] | null> {
  const byFile = new Map(histories.map((h) => [h.file, h]));
  return new Promise((resolve) => {
    const rg = spawn(
      "rg",
      [
        "--no-config",
        "--fixed-strings",
        "--ignore-case",
        "--with-filename",
        "--no-line-number",
        "--null",
        "--no-messages",
        ...terms.flatMap((t) => ["-e", t]),
        "--",
        ...byFile.keys(),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const hits: SearchHit[] = [];
    rg.on("error", () => resolve(null));
    readline.createInterface({ input: rg.stdout, crlfDelay: Infinity }).on("line", (line) => {
      const cut = line.indexOf("\0");
      const h = byFile.get(line.slice(0, cut));
      if (!h) return;
      try {
        const hit = hitIn(h, JSON.parse(line.slice(cut + 1)) as Message, query, !!opts.toolOutput);
        if (hit) hits.push(hit);
      } catch {
        // A line cut short by a write in progress: skip it.
      }
    });
    rg.on("close", (code) => resolve(code === 2 && hits.length === 0 ? null : hits));
  });
}

async function readAll(
  histories: StoredHistory[],
  query: string,
  opts: StoredSearch,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (const h of histories) {
    let text: string;
    try {
      text = await fs.promises.readFile(h.file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const hit = hitIn(h, JSON.parse(line) as Message, query, !!opts.toolOutput);
        if (hit) hits.push(hit);
      } catch {
        // As above.
      }
    }
  }
  return hits;
}
