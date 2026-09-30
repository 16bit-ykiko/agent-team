// Every folder is part of a project; the workspaces from before projects
// are its history, which the lead can search and read.
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setupProjects } from "./projectHarness";
import { Workspace, type Message } from "../../src/workspace/workspace";

const msg = (id: string, content: string, t: number): Message => ({
  id,
  kind: "user",
  agentId: null,
  content,
  timestamp: t,
  status: "done",
});

function setup() {
  const s = setupProjects();
  let n = 0;
  // A workspace from before projects: no link, archived, history on disk.
  const old = (name: string, cwd: string, messages: Message[], archived = true) => {
    const w = new Workspace(`old-${++n}`, name, path.basename(cwd), "local", cwd, s.registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    w.addAgent("A", "claude-opus-5-5", "a", "#fff", { backend: "claude" });
    w.lastActivityAt = messages.at(-1)?.timestamp ?? 0;
    if (archived) {
      w.archivedAt = 1;
      s.store(w, messages);
    } else w.setMessages(messages);
    s.workspaces.set(w.id, w);
    return w;
  };
  return { ...s, old };
}

describe("a folder's project", () => {
  it("comes into being once, with its lead, and a worktree belongs to its repository", () => {
    const { manager, base, workspaces } = setup();
    const repo = path.join(base, "clice");
    fs.mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    git("worktree", "add", "-q", path.join(base, "clice-fix"));

    const project = manager.ensureFor(repo);
    expect(project).toMatchObject({ name: "clice", root: repo });
    expect(workspaces.get(project.leadWorkspaceId!)!.agents.size).toBe(1);
    expect(manager.ensureFor(repo).id).toBe(project.id);
    expect(manager.ensureFor(path.join(base, "clice-fix")).id).toBe(project.id);
    expect(manager.list()).toHaveLength(1);
    expect(() => manager.create("again", repo)).toThrow(`${repo} is already the project "clice"`);

    // Outside git a folder is its own repository.
    const notes = path.join(base, "notes");
    fs.mkdirSync(notes);
    expect(manager.ensureFor(notes)).toMatchObject({ name: "notes", root: notes });
  });

  it("takes in every workspace from before projects; a folder of archived ones is an archived project", () => {
    const { manager, root, base, old, workspaces } = setup();
    fs.mkdirSync(path.join(base, "clice2"));
    const live = old("parser", root, [msg("m1", "hi", 1)], false);
    const past = old("older", root, [msg("m2", "hi", 2)]);
    const stale = old("stale", path.join(base, "clice2"), [msg("m3", "hi", 3)]);
    manager.adoptAll();
    const [repo, clice2] = [root, path.join(base, "clice2")].map((r) =>
      manager.list().find((p) => p.root === r)!,
    );
    expect(repo.archivedAt ?? null).toBeNull();
    expect(clice2.archivedAt).toBeGreaterThan(0);
    expect([live, past].map((w) => w.projectLink)).toEqual([
      { projectId: repo.id, role: "worker" },
      { projectId: repo.id, role: "worker" },
    ]);
    expect(stale.projectLink).toEqual({ projectId: clice2.id, role: "worker" });
    expect(past.isArchived).toBe(true);
    // Once is enough: nothing is left out the second time.
    const count = workspaces.size;
    manager.adoptAll();
    expect(workspaces.size).toBe(count);
    expect(manager.list()).toHaveLength(2);
    // Work in an archived project's folder brings it back.
    manager.ensureFor(path.join(base, "clice2"));
    expect(manager.list().find((p) => p.id === clice2.id)!.archivedAt).toBeNull();
  });

  it("takes in a workspace from before projects when it is restored", () => {
    const { manager, root, old } = setup();
    const w = old("parser", root, [msg("m1", "hi", 1)], false);
    manager.adopt(w);
    const project = manager.list()[0];
    expect(project.root).toBe(root);
    expect(w.projectLink).toEqual({ projectId: project.id, role: "worker" });
    expect(manager.toolsFor(w)!.tools.map((t) => t.name)).toContain("finish_task");
  });
});

describe("the lead's history tools", () => {
  it("list the archived sessions in the repository's folders, or everywhere", async () => {
    const { create, call, root, base, old } = setup();
    const { lead } = create("clice");
    const inRepo = old("parser work", root, [msg("m1", "fix the parser", 1000)]);
    old("sub", path.join(root, "wt"), [msg("m2", "worktree", 2000)]);
    old("elsewhere", path.join(base, "other"), [msg("m3", "unrelated", 3000)]);

    const listed = await call(lead, "list_history");
    expect(listed).toContain(`${inRepo.id} "parser work" in ${root}`);
    expect(listed).toContain('"sub"');
    expect(listed).not.toContain("elsewhere");
    expect(await call(lead, "list_history", { everywhere: true })).toContain('"elsewhere"');
  });

  it("search unloaded histories, and read a hit in its context", async () => {
    const { create, call, root, old } = setup();
    const { lead } = create("clice");
    const w = old(
      "crash hunt",
      root,
      Array.from({ length: 20 }, (_, i) =>
        msg(`m${i}`, i === 12 ? "the ASAN report points at TemplateResolver" : `step ${i}`, i),
      ),
    );
    expect(w.messagesLoaded).toBe(false);
    const hits = await call(lead, "search_history", { query: "asan templateresolver" });
    expect(hits).toContain(`${w.id} "crash hunt"`);
    expect(hits).toContain("message m12");
    expect(await call(lead, "search_history", { query: "nothing like this" })).toContain(
      "nothing matches",
    );

    const around = await call(lead, "read_session", { session_id: w.id, around: "m12" });
    expect(around).toContain(`Session ${w.id} "crash hunt" in ${root} — archived`);
    const ids = around
      .split("\n")
      .filter((l) => l.startsWith("--- "))
      .map((l) => l.split(" · ").at(-1));
    expect(ids).toEqual(["m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16", "m17"]);
  });

  it("search everything recorded: tool calls and output, thinking, subagents; read an entry by lines", async () => {
    const { create, call, root, old } = setup();
    const { lead } = create("clice");
    const log = Array.from({ length: 300 }, (_, i) =>
      i === 249 ? "FAILED: TemplateResolver.PartialSpec" : `test ${i + 1} ok`,
    ).join("\n");
    const w = old("crash hunt", root, [
      msg("u1", "TemplateResolver 在偏特化上崩溃", 1000),
      {
        ...msg("a1", "Found it.", 2000),
        kind: "agent",
        agentId: "a",
        events: [
          { kind: "thinking", content: "maybe the overload set is empty" },
          {
            kind: "tool_use",
            content: "**Bash** `ctest -R Parser`",
            toolName: "Bash",
            toolUseId: "t1",
            toolResult: log,
          },
          {
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "k1",
              description: "Look at the resolver",
              agentType: "Explore",
              events: [
                { kind: "text", content: "The bug is in resolver.cpp, line 88." },
                {
                  kind: "tool_use",
                  content: "**Read** `/src/resolver.cpp`",
                  toolName: "Read",
                  toolInput: { tool: "Read", file_path: "/src/resolver.cpp" },
                  toolResult: "int resolve();",
                },
              ],
            },
          },
        ],
      },
    ]);
    const hit = (out: string) => /^- #(\d+) /m.exec(out)?.[1];

    // What was said, unless asked for more.
    expect(await call(lead, "search_history", { query: "PartialSpec" })).toContain(
      "nothing matches",
    );
    const failed = await call(lead, "search_history", {
      query: "PartialSpec",
      in: ["tool_output"],
    });
    expect(failed).toContain(`${w.id} "crash hunt"`);
    expect(failed).toContain("tool_output Bash · message a1");
    expect(failed).toContain("250: FAILED: TemplateResolver.PartialSpec");
    // A tool's calls and output; a pattern, at lines; a subagent's work.
    const bash = await call(lead, "search_history", { tool: "bash" });
    expect(bash.match(/^- #/gm)).toHaveLength(2);
    expect(bash).toContain("tool_call Bash");
    expect(
      await call(lead, "search_history", { regex: "^FAILED: \\w+\\.Partial", in: ["tool_output"] }),
    ).toContain("250: FAILED");
    const sub = await call(lead, "search_history", { query: "resolver.cpp", level: "subagents" });
    expect(sub).toContain("said by subagent, in a subagent");
    expect(sub).not.toContain("tool_call");
    expect(
      await call(lead, "search_history", { query: "/src/resolver.cpp", in: ["tool_call"] }),
    ).toContain("tool_call Read, in a subagent");
    expect(await call(lead, "search_history", { query: "overload", in: ["thinking"] })).toContain(
      "thinking",
    );
    // Two characters, and case.
    expect(await call(lead, "search_history", { query: "偏特" })).toContain("message u1");
    expect(
      await call(lead, "search_history", { query: "templateresolver", case_sensitive: true }),
    ).toContain("nothing matches");
    // Time and pages.
    expect(
      await call(lead, "search_history", { query: "resolver", since: "2030-01-01" }),
    ).toContain("nothing matches");
    const page = await call(lead, "search_history", { query: "resolver", limit: 1 });
    expect(page).toContain("(more: offset 1)");
    expect(page).toContain("message a1");
    expect(
      await call(lead, "search_history", { query: "resolver", limit: 1, offset: 1 }),
    ).toContain("message u1");
    await expect(call(lead, "search_history", { query: "x", since: "someday" })).rejects.toThrow(
      "since: not a date",
    );

    // The whole output, by lines.
    const entry = Number(hit(failed));
    const lines = await call(lead, "read_entry", { entry, from_line: 249, lines: 3 });
    expect(lines).toContain("lines 249–251 of 300");
    expect(lines.split("\n").slice(1)).toEqual([
      "249: test 249 ok",
      "250: FAILED: TemplateResolver.PartialSpec",
      "251: test 251 ok",
      "(more: from_line 252)",
    ]);
    // The session with its tool calls by entry.
    const read = await call(lead, "read_session", { session_id: w.id, tools: true });
    expect(read).toContain(`#${entry} tool_output Bash · 300 lines`);
    expect(read).toContain("subagent Explore · 1 lines · Look at the resolver");
  });

  it("search like grep: phrases, context, one message, a tool by its own name, and say where else to look", async () => {
    const { create, call, root, old } = setup();
    const { lead } = create("clice");
    const log = ["build started", "step 1", "error: undefined symbol", "step 3", "done"].join("\n");
    const call1 = {
      kind: "tool_use" as const,
      content: "**Bash**\n```bash\nninja -C build\n```",
      toolName: "Bash",
      toolUseId: "t1",
      toolResult: log,
    };
    const panel = {
      kind: "tool_use" as const,
      content: "**start_session** fix in `wt`",
      toolName: "mcp__panel__start_session",
      toolUseId: "t2",
    };
    const w = old("link errors", root, [
      {
        ...msg("a1", "The build links now.", Date.parse("2026-09-29T02:00:00Z")),
        kind: "agent",
        agentId: "a",
        events: [call1, panel],
      },
      {
        ...msg("a2", "undefined symbol again", Date.parse("2026-09-29T03:00:00Z")),
        kind: "agent",
        agentId: "a",
        events: [call1],
      },
    ]);
    const context = await call(lead, "search_history", {
      query: '"undefined symbol"',
      in: ["tool_output"],
      message: "a1",
      context: 1,
    });
    expect(context.match(/^- #/gm)).toHaveLength(1);
    expect(context).toContain(`output of #`);
    expect(context).toContain(": ninja -C build");
    expect(context.split("\n").slice(1, 4)).toEqual([
      "  2- step 1",
      "  3: error: undefined symbol",
      "  4- step 3",
    ]);
    // The output of a command, whatever it printed.
    const ninja = await call(lead, "search_history", {
      call: "ninja",
      query: "done",
      session: w.id,
    });
    expect(ninja.match(/^- #/gm)).toHaveLength(2);
    expect(ninja).toContain("tool_output Bash");
    expect(
      await call(lead, "search_history", { call: "cmake", query: "done", session: w.id }),
    ).toContain("nothing matches");
    // Sessions in a folder.
    expect(
      await call(lead, "search_history", { query: "undefined", folder: "wt", in: ["said"] }),
    ).toContain("nothing matches");
    expect(
      await call(lead, "search_history", { query: "undefined", folder: root, in: ["said"] }),
    ).toContain("message a2");
    // A phrase is not its words anywhere.
    expect(
      await call(lead, "search_history", { query: '"symbol undefined"', in: ["tool_output"] }),
    ).toContain("nothing matches");
    // An MCP tool by its own name; the command first in a call.
    expect(await call(lead, "search_history", { tool: "start_session" })).toContain("fix in wt");
    const calls = await call(lead, "search_history", {
      tool: "bash",
      in: ["tool_call"],
      session: w.id,
    });
    expect(calls).toContain("  1: ninja -C build");
    // Nothing said: where else it is; no such tool: the ones there are.
    const said = await call(lead, "search_history", { query: "ninja", session: w.id });
    expect(said).toContain("(nothing matches in said)");
    expect(said).toContain("(it does in 2 tool_call entries: ask with in)");
    expect(await call(lead, "search_history", { tool: "Rust", session: w.id })).toContain(
      "(the tools used there: Bash, mcp__panel__start_session)",
    );
    // Times without a zone are UTC, as the hits print them.
    const late = await call(lead, "search_history", {
      query: "undefined",
      since: "2026-09-29T02:30",
    });
    expect(late).toContain("message a2");
    expect(late).not.toContain("message a1");
    // A session from its start.
    const first = await call(lead, "read_session", { session_id: w.id, start: true, last: 1 });
    expect(first).toContain("· a1");
    expect(first).not.toContain("· a2");
  });

  it("answer read-only SQL over the histories the lead may read", async () => {
    const { create, call, root, old } = setup();
    const { lead } = create("clice");
    const w = old("crash hunt", root, [msg("u1", "one", 1), msg("u2", "two", 2)]);
    const rows = await call(lead, "query_history", {
      sql: `select s.name, e.kind, count(*) as n from entries e join sessions s on s.id = e.session
            where e.session = '${w.id}' group by s.name, e.kind`,
    });
    expect(rows.split("\n")).toEqual(["name\tkind\tn", "crash hunt\tsaid\t2", "(1 rows)"]);
    expect(
      await call(lead, "query_history", {
        sql: `select json_extract(body, '$.content') as c from messages where session = '${w.id}' order by seq`,
      }),
    ).toBe("c\none\ntwo\n(2 rows)");
    for (const sql of ["delete from main.entries", "delete from history.messages"]) {
      await expect(call(lead, "query_history", { sql })).rejects.toThrow("readonly");
    }
    await expect(call(lead, "query_history", { sql: "delete from entries" })).rejects.toThrow(
      "cannot modify entries",
    );
  });

  it("search the lead's own conversation and its workers' as they go", async () => {
    const { create, call, saveAll, workers } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "fix", cwd: "wt", task: "fix the lexer overflow" });
    const [worker] = workers();
    saveAll();
    expect(await call(lead, "search_history", { query: "lexer overflow" })).toContain(
      `${worker.id} "fix"`,
    );
  });

  it("do not reach into another project's sessions, live or archived", async () => {
    const { create, call, workers, saveAll } = setup();
    const a = create("a");
    const b = create("b");
    await call(b.lead, "start_session", { title: "theirs", cwd: "wt", task: "zebra" });
    const [theirs] = workers();
    for (const id of [b.lead.id, theirs.id]) {
      await expect(call(a.lead, "read_session", { session_id: id })).rejects.toThrow(
        "in this project or its history",
      );
    }
    theirs.archivedAt = 1;
    await expect(call(a.lead, "read_session", { session_id: theirs.id })).rejects.toThrow(
      "in this project or its history",
    );
    expect(await call(a.lead, "list_history", { everywhere: true })).not.toContain(theirs.id);
    saveAll();
    const query = { query: "zebra", everywhere: true };
    expect(await call(a.lead, "search_history", query)).toContain("nothing matches");
    const found = await call(b.lead, "search_history", query);
    const entry = Number(/^- #(\d+) /m.exec(found)![1]);
    await expect(call(a.lead, "read_entry", { entry })).rejects.toThrow(
      "in this project or its history",
    );
    const count = `select count(*) as n from entries where session = '${theirs.id}'`;
    expect(await call(a.lead, "query_history", { sql: count })).toBe("n\n0\n(1 rows)");
    expect(await call(b.lead, "query_history", { sql: count })).not.toBe("n\n0\n(1 rows)");
  });
});
