// Saved histories searched with ripgrep (a line is one message), or read in
// turn where rg is missing: the same answers either way.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchStored, type StoredHistory } from "../../src/workspace/history-search";
import { historyPath, saveWorkspace } from "../../src/workspace/state";
import type { Message } from "../../src/workspace/workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const msg = (id: string, content: string, t: number, over: Partial<Message> = {}): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content,
  timestamp: t,
  status: "done",
  ...over,
});

function histories(): StoredHistory[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-search-"));
  dirs.push(dir);
  const write = (id: string, name: string, lines: string[]): StoredHistory => {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
    return { id, name, file };
  };
  return [
    write("w1", "clice parser", [
      JSON.stringify(msg("a1", "TemplateResolver crashes on partial specialisations", 1)),
      JSON.stringify(msg("a2", "unrelated", 2)),
      JSON.stringify(
        msg("a3", "ran the tests", 3, {
          events: [
            {
              kind: "tool_use",
              content: "**Bash** ctest",
              toolResult: "FAILED: TemplateResolver.PartialSpec",
            },
          ],
        }),
      ),
      '{"id":"torn","kind":"agent","content":"TemplateResolver',
    ]),
    write("w2", "kotatsu", [
      JSON.stringify(msg("b1", "a TemplateResolver note, later", 5)),
      JSON.stringify(msg("b2", "partial specialisations elsewhere", 6)),
    ]),
    { id: "gone", name: "gone", file: path.join(dir, "gone.jsonl") },
  ];
}

function search(query: string, toolOutput = false, limit = 20) {
  return searchStored(histories(), query, { limit, toolOutput });
}

describe.each([
  ["with ripgrep", undefined],
  ["without ripgrep", ""],
])("stored histories %s", (_, pathEnv) => {
  const saved = process.env.PATH;
  afterEach(() => {
    process.env.PATH = saved;
  });
  const at = () => {
    if (pathEnv !== undefined) process.env.PATH = pathEnv;
  };

  it("find what was said with every word, newest first", async () => {
    at();
    const hits = await search("templateresolver partial");
    expect(hits.map((h) => [h.workspaceId, h.messageId])).toEqual([["w1", "a1"]]);
    expect(hits[0].snippet).toContain("TemplateResolver crashes");
    const all = await search("templateresolver");
    expect(all.map((h) => h.messageId)).toEqual(["b1", "a1"]);
    expect((await search("templateresolver", false, 1)).map((h) => h.messageId)).toEqual(["b1"]);
  });

  it("count the history's name as a word, but not alone", async () => {
    at();
    expect((await search("kotatsu partial")).map((h) => h.messageId)).toEqual(["b2"]);
    expect(await search("kotatsu")).toEqual([]);
  });

  it("search what tools returned only when asked", async () => {
    at();
    expect((await search("partialspec")).length).toBe(0);
    const hits = await search("partialspec", true);
    expect(hits.map((h) => h.messageId)).toEqual(["a3"]);
    expect(hits[0].snippet).toMatch(/^\[tool\] /);
  });

  it("read what was said from the text beside a history, the tools from the history", async () => {
    at();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-search-"));
    dirs.push(base);
    saveWorkspace(base, {
      id: "w3",
      name: "clice",
      project: "p",
      hostId: "local",
      cwd: base,
      agents: [],
      createdAt: 1,
      messages: [
        msg("c1", "TemplateResolver crash", 1, {
          events: [{ kind: "tool_result", content: "", toolResult: "FAILED: PartialSpec" }],
        }),
      ],
    });
    const file = historyPath(base, "w3");
    const find = (q: string, toolOutput = false) =>
      searchStored([{ id: "w3", name: "clice", file }], q, { limit: 5, toolOutput });
    expect((await find("templateresolver")).map((h) => h.messageId)).toEqual(["c1"]);
    expect((await find("partialspec", true)).map((h) => h.snippet)).toEqual([
      "[tool] FAILED: PartialSpec",
    ]);
    fs.writeFileSync(file, "");
    expect((await find("templateresolver")).map((h) => h.messageId)).toEqual(["c1"]);
    expect(await find("partialspec", true)).toEqual([]);
  });
});
