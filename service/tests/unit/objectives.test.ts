import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  ObjectiveStore,
  dependencies,
  cycleThrough,
  parse,
  serialize,
  type Objective,
} from "../../src/project/objectives";
import { setupProjects as setup, tick, tmpDir as tmp } from "./projectHarness";

const objective = (id: string, over: Partial<Objective> = {}): Objective => ({
  id,
  area: id.split("/")[0],
  title: id,
  goal: "g",
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: Date.parse("2026-09-29T01:02:03Z"),
  ...over,
});

describe("objective files", () => {
  it("round-trip every field, multi-line text included", () => {
    const o = objective("core/modules", {
      title: 'Modules "C++20"',
      goal: 'line one\nline """two""" with \\ and a closing "',
      status: "later",
      priority: "low",
      reason: "after the index",
      context: "ctx\twith a tab\r\nand a CR",
      dependsOn: ["index/format"],
      tasks: [{ id: "t1", text: "a\nb", state: "doing", session: "ws-1" }],
      decisions: [
        { id: "d1", question: "which std?", outcome: "C++20" },
        { id: "d2", question: "open one" },
      ],
      sessions: ["ws-1"],
      notes: "n",
    });
    const text = serialize(o);
    expect(text).toContain('goal = """\nline one');
    expect(parse("core/modules", text)).toEqual(o);
  });

  it("keep a dropped objective with a priority given by hand whole", () => {
    const o = objective("core/old", {
      goal: "",
      status: "dropped",
      priority: "high",
      reason: "r",
    });
    expect(parse("core/old", serialize(o))).toEqual(o);
  });

  it("keep a dropped objective as its title and the reason only", () => {
    const o = objective("core/old", { goal: "", status: "dropped", reason: "replaced by Bazel" });
    const text = serialize(o);
    expect(text.split("\n").slice(1)).toEqual([
      'title = "core/old"',
      'status = "dropped"',
      'reason = "replaced by Bazel"',
      "updated = 2026-09-29T01:02:03.000Z",
      "",
    ]);
    expect(parse("core/old", text)).toEqual(o);
    // Only a dropped one may go without a goal.
    expect(() => parse("a/b", 'title = "t"\nstatus = "later"\n')).toThrow("missing goal");
  });

  it("date a context with when and at which commit it was written", () => {
    const o = objective("core/x", {
      context: "lexer done",
      contextWritten: Date.parse("2026-10-13T04:00:00Z"),
      contextCommit: "6974365ab",
    });
    const text = serialize(o);
    expect(text).toContain(
      'context_written = 2026-10-13T04:00:00.000Z\ncontext_commit = "6974365ab"\ncontext = "lexer done"',
    );
    expect(parse("core/x", text)).toEqual(o);
    expect(() => parse("a/b", 'title = "t"\ngoal = "g"\ncontext_written = "yesterday"\n')).toThrow(
      "context_written must be a date",
    );
  });

  it("read hand-written files with defaults and report what is wrong", () => {
    expect(parse("a/b", 'title = "t"\ngoal = "g"\n', 5)).toMatchObject({
      status: "active",
      priority: "normal",
      tasks: [],
      updatedAt: 5,
    });
    expect(() => parse("a/b", 'title = "t"\n')).toThrow("missing goal");
    expect(() => parse("a/b", 'title = "t"\ngoal = "g"\nstatus = "soon"\n')).toThrow(
      "status must be one of",
    );
    expect(() =>
      parse("a/b", 'title = "t"\ngoal = "g"\n[[tasks]]\ntext = "x"\nstate = "maybe"\n'),
    ).toThrow("tasks[0].state");
  });

  it("list broken files without ever writing over them", () => {
    const store = new ObjectiveStore(tmp());
    store.write(objective("core/a"));
    const file = path.join(store.dir, "core", "b.toml");
    fs.writeFileSync(file, 'title = "b"\ngoal = ');
    const listed = store.list();
    expect(listed.map((o) => o.id)).toEqual(["core/a", "core/b"]);
    expect(listed[1]).toMatchObject({ id: "core/b", error: expect.any(String) as string });
    expect(() => store.write(objective("core/b"))).toThrow("fix the file first");
    expect(fs.readFileSync(file, "utf-8")).toBe('title = "b"\ngoal = ');
    expect(() => store.get("core/b")).toThrow("cannot be read");
  });

  it("pick up hand edits and reject bad ids", () => {
    const store = new ObjectiveStore(tmp());
    store.write(objective("core/a"));
    expect(store.list()).toHaveLength(1);
    const file = path.join(store.dir, "core", "a.toml");
    fs.writeFileSync(file, 'title = "edited"\ngoal = "g"\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(store.list()[0]).toMatchObject({ title: "edited" });
    expect(() => store.write(objective("Core/A"))).toThrow("Bad objective id");
    expect(() => store.get("../x")).toThrow("Bad objective id");
  });

  it("tell what blocks what and find cycles through an objective", () => {
    const all = [
      objective("a/base", { status: "done" }),
      objective("a/gave-up", { status: "dropped" }),
      objective("a/mid", { dependsOn: ["a/base", "a/gone", "a/gave-up"] }),
      objective("a/top", { dependsOn: ["a/mid"] }),
    ];
    const deps = dependencies(all);
    expect(deps.get("a/mid")).toEqual({
      blockedBy: [],
      unblocks: ["a/top"],
      dropped: ["a/gave-up"],
      missing: ["a/gone"],
    });
    expect(deps.get("a/top")!.blockedBy).toEqual(["a/mid"]);
    expect(cycleThrough(all, "a/top")).toBeNull();
    const looped = [
      objective("a/x", { dependsOn: ["a/y"] }),
      objective("a/y", { dependsOn: ["a/x"] }),
    ];
    expect(cycleThrough(looped, "a/x")).toEqual(["a/x", "a/y", "a/x"]);
    // A cycle among its prerequisites is not one through the objective.
    const beside = [...looped, objective("a/z", { dependsOn: ["a/x"] })];
    expect(cycleThrough(beside, "a/z")).toBeNull();
  });
});

describe("the lead's objective tools", () => {
  it("create, patch and list objectives with what blocks them", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    expect(
      await call(lead, "write_objective", { id: "index/format", title: "Format", goal: "v2" }),
    ).toBe("Created index/format [active, normal].");
    await expect(call(lead, "write_objective", { id: "core/x", title: "x" })).rejects.toThrow(
      "give it a title and a goal",
    );
    expect(
      await call(lead, "write_objective", {
        id: "core/modules",
        title: "Modules",
        goal: "C++20 modules",
        priority: "high",
        depends_on: ["index/format", "core/later"],
      }),
    ).toBe(
      "Created core/modules [active, high]. Depends on: index/format, core/later. Not objectives (yet): core/later.",
    );
    await call(lead, "write_objective", { id: "core/modules", status: "later", reason: "wait" });
    expect(objectives().find((o) => o.id === "core/modules")).toMatchObject({
      title: "Modules",
      status: "later",
      reason: "wait",
      priority: "high",
    });
    expect(await call(lead, "list_objectives")).toBe(
      [
        "## core",
        "- core/modules [later, high] Modules — tasks 0/0; blocked by index/format",
        "",
        "## index",
        "- index/format [active, normal] Format — tasks 0/0",
      ].join("\n"),
    );
    expect(await call(lead, "list_objectives", { status: "later" })).toContain("core/modules");
    expect(await call(lead, "list_objectives", { area: "index" })).not.toContain("core/");
  });

  it("refuse a dependency cycle", async () => {
    const { create, call } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "write_objective", { id: "a/y", title: "y", goal: "g", depends_on: ["a/x"] });
    await expect(call(lead, "write_objective", { id: "a/x", depends_on: ["a/y"] })).rejects.toThrow(
      "dependency cycle: a/x → a/y → a/x",
    );
  });

  it("add and settle tasks and decisions", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    expect(
      await call(lead, "add_items", {
        objective_id: "a/x",
        tasks: ["one", "two"],
        decisions: ["q?"],
      }),
    ).toBe("Added t1, t2, d1 to a/x.");
    expect(await call(lead, "add_items", { objective_id: "a/x", tasks: ["three"] })).toBe(
      "Added t3 to a/x.",
    );
    await call(lead, "update_item", { objective_id: "a/x", item_id: "t2", state: "done" });
    await call(lead, "update_item", { objective_id: "a/x", item_id: "d1", outcome: "yes" });
    await expect(
      call(lead, "update_item", { objective_id: "a/x", item_id: "d1", state: "done" }),
    ).rejects.toThrow("settle it with an outcome");
    await expect(
      call(lead, "update_item", { objective_id: "a/x", item_id: "t9", state: "done" }),
    ).rejects.toThrow("No item t9 in a/x");
    const [o] = objectives();
    expect(o.tasks.map((t) => t.state)).toEqual(["todo", "done", "todo"]);
    expect(o.decisions).toEqual([{ id: "d1", question: "q?", outcome: "yes" }]);
    await call(lead, "update_item", { objective_id: "a/x", item_id: "d1", outcome: "" });
    expect(objectives()[0].decisions[0].outcome).toBeUndefined();
    expect(await call(lead, "read_objective", { id: "a/x" })).toContain(
      "tasks:\n- t1 [todo] one\n- t2 [done] two\n- t3 [todo] three\n\ndecisions:\n- d1 open: q?",
    );
  });

  it("keep what is dropped as its title and reason, and delete what is done", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "build/cmake", title: "CMake", goal: "g" });
    await call(lead, "add_items", { objective_id: "build/cmake", tasks: ["presets"] });
    await expect(
      call(lead, "write_objective", { id: "build/cmake", status: "dropped" }),
    ).rejects.toThrow("Say why build/cmake is dropped");
    expect(
      await call(lead, "write_objective", {
        id: "build/cmake",
        status: "dropped",
        reason: "Bazel builds clice",
      }),
    ).toBe("Updated build/cmake [dropped, normal]. Kept as its title and the reason.");
    expect(objectives()[0]).toMatchObject({
      title: "CMake",
      goal: "",
      reason: "Bazel builds clice",
      tasks: [],
    });
    await expect(
      call(lead, "write_objective", { id: "build/cmake", status: "active" }),
    ).rejects.toThrow("give it a goal");
    await expect(
      call(lead, "write_objective", { id: "build/cmake", status: "done" }),
    ).rejects.toThrow("is deleted, not marked done: delete_objective");
    // Nothing is added to a dropped one.
    await expect(
      call(lead, "add_items", { objective_id: "build/cmake", tasks: ["t"] }),
    ).rejects.toThrow("build/cmake is dropped: make it active first");
    // The reason of a dropped one is the drop's: a priority does not clear it.
    await call(lead, "write_objective", { id: "build/cmake", priority: "low" });
    expect(objectives()[0].reason).toBe("Bazel builds clice");
    // Dropped from the start: no goal to give.
    await call(lead, "write_objective", {
      id: "build/make",
      title: "Make",
      status: "dropped",
      reason: "never",
    });
    expect(await call(lead, "read_objective", { id: "build/make" })).toBe(
      "build/make — Make\nstatus: dropped — never",
    );
  });

  it("refuse board text over its limit, and a task over one line", async () => {
    const { create, call } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await expect(
      call(lead, "write_objective", { id: "a/x", context: "x".repeat(1001) }),
    ).rejects.toThrow(
      "The context is 1001 characters, over the 1000 the board takes. Rewrite it shorter: where things stand now, not how they got there; the history keeps everything said and done.",
    );
    await expect(
      call(lead, "write_objective", { id: "a/x", notes: "x".repeat(501) }),
    ).rejects.toThrow("links to design docs");
    await expect(
      call(lead, "add_items", { objective_id: "a/x", tasks: ["one\ntwo"] }),
    ).rejects.toThrow("A task is one line");
    await expect(
      call(lead, "add_items", { objective_id: "a/x", tasks: ["x".repeat(201)] }),
    ).rejects.toThrow("The task is 201 characters");
    await expect(
      call(lead, "add_items", { objective_id: "a/x", decisions: ["x".repeat(301)] }),
    ).rejects.toThrow("A question is 301 characters");
    await call(lead, "add_items", { objective_id: "a/x", tasks: ["one"], decisions: ["q?"] });
    await expect(
      call(lead, "update_item", { objective_id: "a/x", item_id: "d1", outcome: "y".repeat(301) }),
    ).rejects.toThrow("The outcome is 301 characters");
    // Text already longer, written by hand, still reads.
    expect(await call(lead, "read_objective", { id: "a/x" })).toContain("- t1 [todo] one");
  });

  it("remove a task or a decision that no longer matters", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "add_items", {
      objective_id: "a/x",
      tasks: ["one", "two"],
      decisions: ["q?"],
    });
    expect(
      await call(lead, "update_item", { objective_id: "a/x", item_id: "t1", remove: true }),
    ).toBe("Removed a/x t1.");
    await call(lead, "update_item", { objective_id: "a/x", item_id: "d1", remove: true });
    expect(objectives()[0].tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(objectives()[0].decisions).toEqual([]);
    await expect(
      call(lead, "update_item", { objective_id: "a/x", item_id: "d1", remove: true }),
    ).rejects.toThrow("No item d1 in a/x");
  });

  it("say how old a context is: when it was written, at which commit, and how many came since", async () => {
    const { create, call, root, objectives } = setup();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=a", ...args], {
        stdio: "ignore",
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const head = () =>
      execFileSync("git", ["-C", root, "rev-parse", "--short=9", "HEAD"], {
        encoding: "utf-8",
      }).trim();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g", context: "lexer" });
    const at = head();
    const today = new Date().toISOString().slice(0, 10);
    expect(await call(lead, "read_objective", { id: "a/x" })).toContain(
      `context (written today (${today}, UTC) at ${at}, 0 commits since):\nlexer`,
    );
    git("commit", "-q", "--allow-empty", "-m", "two");
    expect(await call(lead, "read_objective", { id: "a/x" })).toContain(
      `at ${at}, 1 commit since):`,
    );
    // Written on a branch HEAD does not have: its commit, no count.
    git("switch", "-q", "-c", "side");
    git("commit", "-q", "--allow-empty", "-m", "side");
    await call(lead, "write_objective", { id: "a/x", context: "on a branch" });
    const side = head();
    git("switch", "-q", "main");
    expect(await call(lead, "read_objective", { id: "a/x" })).toContain(
      `at ${side}):\non a branch`,
    );
    // Clearing the context clears its date.
    await call(lead, "write_objective", { id: "a/x", context: "" });
    expect(objectives()[0].contextWritten).toBeUndefined();
    expect(objectives()[0].contextCommit).toBeUndefined();
  });

  it("read an archived objective, refuse to write it, and delete it", async () => {
    const { create, call, objectives, base } = setup();
    const { project, lead } = create("clice");
    const dir = path.join(
      base,
      ".agent-team",
      "projects",
      project.id,
      "objectives",
      "_archive",
      "a",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.toml"), 'title = "old"\ngoal = "g"\nstatus = "done"\n');
    expect(objectives()[0]).toMatchObject({ id: "a/old", archived: true });
    expect(await call(lead, "list_objectives", { archived: true })).toContain("a/old [done");
    expect(await call(lead, "read_objective", { id: "a/old" })).toContain(
      "status: done (archived)",
    );
    await expect(call(lead, "write_objective", { id: "a/old", context: "x" })).rejects.toThrow(
      "a/old is in the archive",
    );
    for (const [tool, args] of [
      ["add_items", { objective_id: "a/old", tasks: ["x"] }],
      ["update_item", { objective_id: "a/old", item_id: "t1", remove: true }],
      ["start_session", { title: "w", cwd: "wt", task: "t", objective_id: "a/old" }],
    ] as const) {
      await expect(call(lead, tool, args), tool).rejects.toThrow(/in the archive|No item/);
    }
    const file = path.join(dir, "old.toml");
    expect(fs.readFileSync(file, "utf-8")).toBe('title = "old"\ngoal = "g"\nstatus = "done"\n');
    // Deleting what an archived one depends on leaves the archive as it is.
    fs.writeFileSync(file, 'title = "old"\ngoal = "g"\nstatus = "done"\ndepends_on = ["a/x"]\n');
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    expect(await call(lead, "delete_objective", { id: "a/x" })).toBe("Deleted a/x.");
    expect(fs.readFileSync(file, "utf-8")).toContain('depends_on = ["a/x"]');
    await call(lead, "delete_objective", { id: "a/old" });
    expect(objectives()).toEqual([]);
  });

  it("date a context only when its text changes, by the calendar day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-12T23:30:00Z"));
      const { create, call, objectives } = setup();
      const { lead } = create("clice");
      await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g", context: "A" });
      const first = objectives()[0].contextWritten;
      vi.setSystemTime(new Date("2026-10-13T00:10:00Z"));
      expect(await call(lead, "read_objective", { id: "a/x" })).toContain(
        "context (written 1 day ago (2026-10-12, UTC)):",
      );
      await call(lead, "write_objective", { id: "a/x", context: "A", priority: "high" });
      expect(objectives()[0].contextWritten).toBe(first);
      await call(lead, "write_objective", { id: "a/x", context: "B" });
      expect(objectives()[0].contextWritten).toBe(Date.parse("2026-10-13T00:10:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bring back a project deleted while a write waited for git", async () => {
    const { create, call, manager, base } = setup();
    const { project, lead } = create("clice");
    const dir = path.join(base, ".agent-team", "projects", project.id);
    const write = call(lead, "write_objective", { id: "a/x", title: "x", goal: "g", context: "c" });
    manager.delete(project.id);
    await expect(write).rejects.toThrow(`No project ${project.id}`);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("delete an objective and take it out of what depended on it", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "write_objective", { id: "a/y", title: "y", goal: "g", depends_on: ["a/x"] });
    await call(lead, "write_issue_group", { module: "m", title: "M", objectives: ["a/x"] });
    await call(lead, "write_issues", {
      issues: [{ id: "i#1", module: "m", text: "t", objectives: ["a/x", "a/y"] }],
    });
    expect(await call(lead, "delete_objective", { id: "a/x" })).toBe(
      "Deleted a/x. Taken out of the depends_on of a/y. Taken out of 2 issue links.",
    );
    expect(objectives().map((o) => [o.id, o.dependsOn])).toEqual([["a/y", []]]);
    expect(await call(lead, "read_issue", { id: "i#1" })).toContain("objectives: a/y (active) y");
  });

  it("broadcast the board when a file is edited by hand", async () => {
    const { create, frames, manager, base } = setup();
    const { project } = create("clice");
    manager.list();
    const dir = path.join(base, ".agent-team", "projects", project.id, "objectives", "core");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hand.toml"), 'title = "by hand"\ngoal = "g"\n');
    const seen = () =>
      frames.some(
        (f) =>
          f.type === "project_updated" &&
          (f.project as { objectives: Array<{ id: string }> }).objectives.some(
            (o) => o.id === "core/hand",
          ),
      );
    for (let i = 0; i < 100 && !seen(); i++) await tick();
    expect(seen()).toBe(true);
    manager.close();
  });
});
