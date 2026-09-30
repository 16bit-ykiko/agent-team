// The search index's edges: paging over sessions searched apart (a word
// that is a session's name), what a word or a pattern matches, and an
// index file that cannot be read.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryService, sidebarHits } from "../../src/workspace/history-service";
import type { SearchQuery } from "../../src/workspace/history-index";
import { closeHistory, historyFile, historyIndexFile, historyOf } from "../../src/workspace/state";
import type { Message } from "../../src/workspace/workspace";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) await c();
});

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-search-edge-"));
  const history = new HistoryService(historyIndexFile(base), historyFile(base));
  cleanups.push(
    () => history.close(),
    () => closeHistory(base),
    () => fs.rmSync(base, { recursive: true, force: true }),
  );
  const save = (session: string, messages: Message[]) => {
    historyOf(base).save(session, messages, "all");
    history.changed();
  };
  return { base, history, save };
}

const msg = (id: string, content: string, timestamp: number): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp,
  status: "done",
});

describe("searching sessions apart, a word being a session's name", () => {
  const sessions = [
    { id: "s1", name: "clice" },
    { id: "s2", name: "agent-team" },
    { id: "s3", name: "clice-extra" },
  ];
  function withHistories() {
    const s = setup();
    s.save("s1", [msg("a", "crash one", 1), msg("c", "crash three", 3), msg("t1", "crash tie", 7)]);
    s.save("s2", [
      msg("b", "clice crash two", 2),
      msg("e", "clice crash five", 5),
      msg("x", "crash, not the name", 6),
      msg("t2", "clice crash tie", 7),
    ]);
    s.save("s3", [msg("d", "crash four", 4)]);
    return s;
  }
  const query = (over: Partial<SearchQuery> = {}) => ({
    terms: ["clice", "crash"],
    limit: 2,
    ...over,
  });

  it("pages through every group in one order, nothing skipped or repeated", async () => {
    const { history } = withHistories();
    const all = await history.searchNamed(query({ limit: 50 }), sessions);
    const ids = all.hits.map((h) => h.message);
    expect(ids.slice(2)).toEqual(["e", "d", "c", "b", "a"]);
    expect(new Set(ids.slice(0, 2))).toEqual(new Set(["t1", "t2"]));
    expect(all.more).toBe(false);
    for (const limit of [1, 2, 3]) {
      const paged: string[] = [];
      const more: boolean[] = [];
      for (let offset = 0; offset < ids.length; offset += limit) {
        const r = await history.searchNamed(query({ limit, offset }), sessions);
        paged.push(...r.hits.map((h) => h.message));
        more.push(r.more);
      }
      expect(paged, `limit ${limit}`).toEqual(ids);
      expect(more.at(-1), `limit ${limit}`).toBe(false);
      expect(more.slice(0, -1).every(Boolean), `limit ${limit}`).toBe(true);
    }
  });

  it("finds a session's entries that hold its name when every word is in the name", async () => {
    const { history, save } = setup();
    save("s1", [msg("m1", "clice now builds on Windows", 1), msg("m2", "unrelated", 2)]);
    const hits = await sidebarHits(history, "clice", [{ id: "s1", name: "clice" }], 10);
    expect(hits.map((h) => h.messageId)).toEqual(["m1"]);
  });

  it("finds a worker's session by the words of its task when its title holds them", async () => {
    const { history, save } = setup();
    save("w1", [msg("m1", "the parser crash is in lexer.cpp", 1)]);
    const r = await history.searchNamed({ terms: ["parser", "crash"], limit: 10 }, [
      { id: "w1", name: "fix parser crash" },
    ]);
    expect(r.hits.map((h) => h.message)).toEqual(["m1"]);
  });
});

describe("what a word or a pattern matches", () => {
  const find = async (history: HistoryService, q: Omit<SearchQuery, "limit">) =>
    (await history.search({ limit: 20, ...q })).hits.map((h) => h.message);

  function withText() {
    const s = setup();
    s.save("w", [
      msg("upper", "Ab cd\nTemplateResolver failed", 1),
      msg("lower", "ab cd\ntemplateresolver ok", 2),
      msg("quote", 'she said "hi" to std::vector<int> with -Wall (c++) a*b NEAR OR', 3),
      msg("de", "Überprüfung der Straße", 4),
      msg("multi", "FAILED: Parser.Partial\nok\nFAILED: Lexer.Other", 5),
    ]);
    return s;
  }

  it("a short word, in any case or in its case", async () => {
    const { history } = withText();
    expect(await find(history, { terms: ["AB"] })).toEqual(["lower", "upper"]);
    expect(await find(history, { terms: ["Ab"], caseSensitive: true })).toEqual(["upper"]);
    expect(await find(history, { terms: ["ab", "TEMPLATERESOLVER"] })).toEqual(["lower", "upper"]);
    expect(await find(history, { terms: ["ab", "templateresolver"], caseSensitive: true })).toEqual(
      ["lower"],
    );
  });

  it("words that are full-text syntax are only text", async () => {
    const { history } = withText();
    for (const t of ['"hi"', "std::vector<int>", "-Wall", "(c++)", "a*b", "NEAR", "OR"]) {
      expect(await find(history, { terms: [t] }), t).toEqual(["quote"]);
    }
  });

  it("letters beyond ASCII in any case, short words too", async () => {
    const { history } = withText();
    expect(await find(history, { terms: ["ÜBERPRÜFUNG"] })).toEqual(["de"]);
    expect(await find(history, { terms: ["STRAßE"] })).toEqual(["de"]);
    expect(await find(history, { terms: ["üb"] })).toEqual(["de"]);
  });

  it("a pattern with words: both must match, the lines shown are the pattern's", async () => {
    const { history } = withText();
    const r = await history.search({ terms: ["lexer"], regex: "^failed: \\w+\\.", limit: 5 });
    expect(r.hits.map((h) => [h.message, h.lines.map((l) => l.n), h.moreLines])).toEqual([
      ["multi", [1, 3], 0],
    ]);
    expect(await find(history, { terms: [], regex: "^failed:", caseSensitive: true })).toEqual([]);
    expect(await find(history, { terms: ["partial"], regex: "Lexer\\.Other$" })).toEqual(["multi"]);
  });
});

describe("an index file that cannot be read", () => {
  it("is rebuilt, being derived", async () => {
    const { base, history, save } = setup();
    save("w", [msg("m1", "zebra", 1)]);
    fs.mkdirSync(path.dirname(historyIndexFile(base)), { recursive: true });
    fs.writeFileSync(historyIndexFile(base), "not a database, not at all".repeat(200));
    const r = await history.search({ terms: ["zebra"], limit: 5 });
    expect(r.hits.map((h) => h.message)).toEqual(["m1"]);
  });
});
