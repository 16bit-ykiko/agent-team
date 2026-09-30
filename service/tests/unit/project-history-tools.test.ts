// The lead's history tools at their limits: what query_history prints, how
// much read_entry and read_session show, a turn not indexed yet, and a
// worker found by the words of its own task.
import { describe, it, expect } from "vitest";
import { setupProjects } from "./projectHarness";
import type { StreamEvent } from "../../src/session/claude";

describe("the lead's history tools at their limits", () => {
  it("query_history prints NULL, bytes, escaped tabs and newlines, cut cells, and stops at 200 rows", async () => {
    const { create, call, saveAll } = setupProjects();
    const { lead } = create("clice");
    saveAll();
    const cells = await call(lead, "query_history", {
      sql: "select null as a, x'00ff10' as b, 'x' || char(9) || 'y' || char(10) || 'z' as c, printf('%.*c', 1500, 'q') as d, 3.5 as e",
    });
    expect(cells.split("\n")).toEqual([
      "a\tb\tc\td\te",
      `NULL\t<3 bytes>\tx  y\\nz\t${"q".repeat(1000)}…(500 more)\t3.5`,
      "(1 rows)",
    ]);
    const many = await call(lead, "query_history", {
      sql: "with recursive c(x) as (select 1 union all select x + 1 from c where x < 250) select x from c",
    });
    const lines = many.split("\n");
    expect(lines).toHaveLength(202);
    expect(lines[200]).toBe("200");
    expect(lines[201]).toBe("(200 rows, stopped at 200: narrow it or page with limit/offset)");
    const exactly = await call(lead, "query_history", {
      sql: "with recursive c(x) as (select 1 union all select x + 1 from c where x < 200) select x from c",
    });
    expect(exactly.split("\n").at(-1)).toBe("(200 rows)");
    expect(await call(lead, "query_history", { sql: "select 1 where 0" })).toBe("(no rows)");
  });

  it("read_entry cuts a very long line; read_session lists at most 60 entries a message", async () => {
    const { create, call, saveAll, workers, session } = setupProjects();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "go" });
    const [w] = workers();
    const emit = (e: StreamEvent) => session(w).emit("event", e);
    emit({
      kind: "tool_use",
      content: "**Bash** `cat big`",
      toolName: "Bash",
      toolUseId: "big",
      toolResult: `short\n${"z".repeat(5000)}`,
    });
    for (let i = 0; i < 69; i++) {
      emit({
        kind: "tool_use",
        content: `**Bash** \`step ${i}\``,
        toolName: "Bash",
        toolUseId: `t${i}`,
        toolResult: `out ${i}`,
      });
    }
    session(w).isRunning = false;
    emit({ kind: "result", content: "" });
    saveAll();

    const found = await call(lead, "search_history", { query: "zzzz", in: ["tool_output"] });
    const entry = Number(/^- #(\d+) /m.exec(found)![1]);
    const read = await call(lead, "read_entry", { entry });
    expect(read.split("\n").slice(1)).toEqual([
      "1: short",
      `2: ${"z".repeat(4000)}…(the line goes on: from_line 2 from_char 4000)`,
    ]);
    const rest = await call(lead, "read_entry", { entry, from_line: 2, from_char: 4000 });
    expect(rest.split("\n").slice(1)).toEqual([`2: ${"z".repeat(1000)}`]);

    const listed = await call(lead, "read_session", { session_id: w.id, tools: true });
    expect(listed.match(/^ {2}#\d+ /gm)).toHaveLength(60);
    expect(listed).toContain(`(+80 more: search_history with session ${w.id} and message `);
  });

  it("read_session says when a turn's tool calls are not indexed yet", async () => {
    const { create, call, saveAll, workers, session } = setupProjects();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "go" });
    const [w] = workers();
    session(w).emit("event", {
      kind: "tool_use",
      content: "**Bash** `make`",
      toolName: "Bash",
      toolUseId: "t1",
    });
    saveAll();
    const read = await call(lead, "read_session", { session_id: w.id, tools: true });
    expect(read).toContain("· 1 tool calls ·");
    expect(read).toContain("(not indexed yet)");
  });

  it("search_history finds a worker by the words of its task, even when its title holds them", async () => {
    const { create, call, saveAll, workers } = setupProjects();
    const { lead } = create("clice");
    await call(lead, "start_session", {
      title: "lexer overflow",
      cwd: "wt",
      task: "fix the lexer overflow",
    });
    const [worker] = workers();
    saveAll();
    expect(await call(lead, "search_history", { query: "lexer overflow" })).toContain(
      `${worker.id} "lexer overflow"`,
    );
  });
});
