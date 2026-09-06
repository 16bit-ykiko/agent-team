import { describe, it, expect } from "vitest";
import { searchMessages, SearchSource } from "../../src/search";

function ws(id: string, name: string, msgs: Array<[string, string, number]>): SearchSource {
  return {
    id,
    name,
    messages: msgs.map(([mid, content, timestamp]) => ({
      id: mid,
      kind: "agent",
      content,
      timestamp,
    })),
  };
}

const sources: SearchSource[] = [
  ws("w1", "clice", [
    ["m1", "Fixed the parser crash in dependency_graph.cpp", 100],
    ["m2", "The lexer needs a rewrite", 200],
  ]),
  ws("w2", "agent-team", [
    ["m3", "Subagent rendering crash reproduced", 300],
    ["m4", "All tests green now", 400],
  ]),
];

describe("searchMessages", () => {
  it("matches case-insensitively and returns newest first", () => {
    const hits = searchMessages(sources, "CRASH");
    expect(hits.map((h) => h.messageId)).toEqual(["m3", "m1"]);
  });

  it("requires all terms to match (AND)", () => {
    expect(searchMessages(sources, "crash parser").map((h) => h.messageId)).toEqual(["m1"]);
    expect(searchMessages(sources, "crash nonexistent")).toEqual([]);
  });

  it("lets a term match the workspace name, but content must hit at least once", () => {
    // "clice" only matches the workspace name; "crash" narrows the content.
    expect(searchMessages(sources, "clice crash").map((h) => h.messageId)).toEqual(["m1"]);
    // A pure name-only query would flood with every message in the workspace.
    expect(searchMessages(sources, "clice")).toEqual([]);
  });

  it("skips system messages and respects the limit", () => {
    const withSystem: SearchSource[] = [
      {
        id: "w3",
        name: "sys",
        messages: [{ id: "s1", kind: "system", content: "crash system", timestamp: 999 }],
      },
      ...sources,
    ];
    expect(searchMessages(withSystem, "crash").map((h) => h.messageId)).toEqual(["m3", "m1"]);
    expect(searchMessages(sources, "crash", 1).map((h) => h.messageId)).toEqual(["m3"]);
  });

  it("builds a bounded single-line snippet around the first match", () => {
    const long = ws("w4", "long", [
      ["mL", "x".repeat(500) + "\nneedle here\n" + "y".repeat(500), 50],
    ]);
    const [hit] = searchMessages([long], "needle");
    expect(hit.snippet).toContain("needle");
    expect(hit.snippet).not.toContain("\n");
    expect(hit.snippet.length).toBeLessThan(120);
    expect(hit.snippet.startsWith("...")).toBe(true);
    expect(hit.snippet.endsWith("...")).toBe(true);
  });

  it("returns [] for empty or whitespace queries", () => {
    expect(searchMessages(sources, "")).toEqual([]);
    expect(searchMessages(sources, "   ")).toEqual([]);
  });
});
