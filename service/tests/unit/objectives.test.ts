import { describe, it, expect } from "vitest";
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

  it("delete an objective and say who still lists it", async () => {
    const { create, call, objectives } = setup();
    const { lead } = create("clice");
    await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
    await call(lead, "write_objective", { id: "a/y", title: "y", goal: "g", depends_on: ["a/x"] });
    expect(await call(lead, "delete_objective", { id: "a/x" })).toBe(
      "Deleted a/x. Still listed as a prerequisite by a/y.",
    );
    expect(objectives().map((o) => o.id)).toEqual(["a/y"]);
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
