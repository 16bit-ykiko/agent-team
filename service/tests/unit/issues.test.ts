import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  IssueStore,
  parseModule,
  serializeModule,
  type IssueModule,
} from "../../src/project/issues";
import { setupProjects as setup, tick, tmpDir } from "./projectHarness";

const MODULE: IssueModule = {
  id: "02-hosting",
  title: "Hosting (hosting.cpp)",
  notes: "Host chains mix configurations.\n\nRe-run on a75797dc.",
  objectives: ["service/release-fixes"],
  issues: [
    { id: "10-07#5", state: "accepted", tags: [], text: "One tree per host.", objectives: [] },
  ],
  groups: [
    {
      id: "4.1",
      title: "Config loading",
      notes: "Only some fields are checked.",
      objectives: [],
      issues: [
        {
          id: "09-23#12",
          state: "open",
          evidence: "R",
          tags: ["部分"],
          text: 'a.cpp `-Iconfig_a`; "quoted" """ text\n\nwhere: dependency_graph.cpp:175',
          objectives: ["index/hosts"],
        },
        { id: "h3r2#1", state: "decision", tags: [], text: "Edges lost.", objectives: [] },
      ],
    },
  ],
  updatedAt: Date.parse("2026-10-07T08:00:00.000Z"),
};

describe("issue files", () => {
  it("read back as written, groups and their issues in order", () => {
    const text = serializeModule(MODULE);
    expect(parseModule(MODULE.id, text)).toEqual(MODULE);
    // Open is the default and is not written; the text comes last.
    expect(text).not.toContain('state = "open"');
    expect(text.indexOf("[[groups.issues]]")).toBeGreaterThan(text.indexOf("[[groups]]"));
  });

  it("refuse misspelt keys, bad states and an issue there twice", () => {
    expect(() =>
      parseModule("m", 'title = "x"\n[[issues]]\nid = "a"\ntext = "t"\nstat = "open"'),
    ).toThrow(/unknown key issues\[0\]\.stat/);
    expect(() =>
      parseModule("m", 'title = "x"\n[[issues]]\nid = "a"\ntext = "t"\nstate = "fixed"'),
    ).toThrow(/state must be one of/);
    const twice =
      'title = "x"\n[[issues]]\nid = "a"\ntext = "t"\n[[groups]]\nid = "g"\ntitle = "g"\n[[groups.issues]]\nid = "a"\ntext = "u"';
    expect(() => parseModule("m", twice)).toThrow(/issue a is there twice/);
  });

  it("keep an unreadable file visible and never write over it", () => {
    const dir = tmpDir();
    const store = new IssueStore(dir);
    fs.writeFileSync(path.join(dir, "paths.toml"), "title = ");
    expect(store.list()).toEqual([{ id: "paths", error: expect.any(String) as string }]);
    expect(() => store.write({ ...MODULE, id: "paths" })).toThrow(/cannot be read/);
    expect(fs.readFileSync(path.join(dir, "paths.toml"), "utf-8")).toBe("title = ");
  });

  it("never hand out a number again, even once its issue is gone", () => {
    const store = new IssueStore(tmpDir());
    const day = new Date(2026, 9, 7);
    expect(store.allocate(["10-07#19", "10-06#40", "F71"], day)).toBe("10-07#20");
    expect(store.allocate([], day)).toBe("10-07#1");
    store.reserve(["10-07#20", "10-07#3", "F71"]);
    expect(store.allocate([], day)).toBe("10-07#21");
    expect(store.allocate([], new Date(2026, 9, 8))).toBe("10-08#1");
  });
});

describe("issue tools", () => {
  async function withModule() {
    const env = setup();
    const { lead } = env.create("clice");
    await env.call(lead, "write_issue_group", { module: "hosting", title: "Hosting" });
    await env.call(lead, "write_issue_group", {
      module: "hosting",
      group: "chain",
      title: "Host chains",
      notes: "One scan mixes configurations.",
    });
    await env.call(lead, "write_issue_group", { module: "paths", title: "Paths" });
    return { ...env, lead };
  }

  it("create issues in a group with the next id, and list them under it", async () => {
    const { call, lead } = await withModule();
    const created = await call(lead, "write_issues", {
      issues: [
        {
          module: "hosting",
          group: "chain",
          evidence: "R",
          tags: ["回归"],
          text: "Wrong host for b.cpp",
        },
        { id: "h3r2#1", module: "hosting", group: "chain", text: "Edges lost" },
        { module: "hosting", text: "Not a defect?", state: "decision" },
      ],
    });
    expect(created).toMatch(
      /^Created \d\d-\d\d#1 in hosting\/chain\.\nCreated h3r2#1 in hosting\/chain\.\nCreated \d\d-\d\d#2 in hosting\.$/,
    );
    const list = await call(lead, "list_issues");
    expect(list).toContain("2 open, 1 to decide, 0 accepted, in 2 modules.");
    expect(list).toContain("## hosting — Hosting");
    expect(list).toContain("### hosting/chain Host chains — One scan mixes configurations.");
    expect(list).toMatch(/- \d\d-\d\d#1 \[R, 回归\] Wrong host for b\.cpp/);
    expect(list).toMatch(/- \d\d-\d\d#2 \[decision\] Not a defect\?/);
    expect(await call(lead, "list_issues", { states: ["decision"] })).not.toContain("h3r2#1");
    expect(await call(lead, "list_issues", { query: "EDGES" })).toContain("h3r2#1");
  });

  it("change an issue where it is, move it to another module, and refuse a bad batch whole", async () => {
    const { call, lead, base, manager } = await withModule();
    await call(lead, "write_issues", {
      issues: [
        { id: "a#1", module: "hosting", group: "chain", text: "first" },
        { id: "a#2", module: "hosting", group: "chain", text: "second" },
      ],
    });
    await call(lead, "write_issues", {
      issues: [{ id: "a#1", evidence: "V", text: "first, probed" }],
    });
    const file = path.join(
      base,
      ".agent-team",
      "projects",
      manager.list()[0].id,
      "issues",
      "hosting.toml",
    );
    const text = fs.readFileSync(file, "utf-8");
    expect(text.indexOf('"a#1"')).toBeLessThan(text.indexOf('"a#2"'));
    expect(text).toContain('evidence = "V"');

    expect(await call(lead, "write_issues", { issues: [{ id: "a#2", module: "paths" }] })).toBe(
      "Updated a#2. Moved to paths.",
    );
    expect(await call(lead, "read_issue", { id: "a#2" })).toContain("in paths — Paths");

    const before = fs.readFileSync(file, "utf-8");
    await expect(
      call(lead, "write_issues", {
        issues: [
          { id: "a#1", text: "changed" },
          { id: "a#3", module: "nowhere", text: "x" },
        ],
      }),
    ).rejects.toThrow(/issues\[1\]: No module nowhere \(there are: hosting, paths\)/);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("close fixed issues by deleting them, their text in the result", async () => {
    const { call, lead } = await withModule();
    await call(lead, "write_issues", {
      issues: [{ id: "x#1", module: "paths", text: "Bad path" }],
    });
    await expect(call(lead, "close_issues", { ids: ["x#1"], fixed_by: "" })).rejects.toThrow(
      /what fixed them/,
    );
    const closed = await call(lead, "close_issues", { ids: ["x#1"], fixed_by: "PR #787" });
    expect(closed).toBe("Closed x#1, fixed by PR #787.\n\nx#1 [open] in paths\nBad path");
    await expect(call(lead, "read_issue", { id: "x#1" })).rejects.toThrow(/No issue x#1/);
    await expect(call(lead, "close_issues", { ids: ["x#1"], fixed_by: "PR #787" })).rejects.toThrow(
      /No issue x#1/,
    );
  });

  it("show an objective's linked issues, its own and its group's, in the board tools", async () => {
    const { call, lead } = await withModule();
    await call(lead, "write_objective", { id: "index/hosts", title: "Hosts", goal: "Right host" });
    await call(lead, "write_issue_group", {
      module: "hosting",
      group: "chain",
      objectives: ["index/hosts"],
    });
    await call(lead, "write_issues", {
      issues: [
        { id: "b#1", module: "hosting", group: "chain", text: "Wrong host" },
        { id: "b#2", module: "paths", text: "Case-insensitive paths", objectives: ["index/hosts"] },
        {
          id: "b#3",
          module: "paths",
          text: "Symlinks",
          state: "accepted",
          objectives: ["index/hosts"],
        },
        { id: "b#4", module: "paths", text: "Unrelated" },
      ],
    });
    expect(await call(lead, "list_objectives")).toContain("tasks 0/0, 2 open issues");
    const read = await call(lead, "read_objective", { id: "index/hosts" });
    expect(read).toContain("issues:\n- b#1 Wrong host\n- b#2 Case-insensitive paths\n(1 accepted");
    expect(await call(lead, "list_issues", { objective: "index/hosts" })).not.toContain("b#4");
    expect(await call(lead, "read_issue", { id: "b#1" })).toContain(
      "objectives: index/hosts (active) Hosts",
    );
    expect(
      await call(lead, "write_issues", { issues: [{ id: "b#4", objectives: ["index/nope"] }] }),
    ).toBe("Updated b#4.\nNot objectives (yet): index/nope.");
  });

  it("let a worker keep the issues too", async () => {
    const { call, lead, workers } = await withModule();
    await call(lead, "start_session", { title: "w", cwd: ".", task: "fix it" });
    const worker = workers()[0];
    await call(worker, "write_issues", { issues: [{ id: "w#1", module: "paths", text: "found" }] });
    expect(await call(worker, "list_issues", { module: "paths" })).toContain("w#1");
    expect(await call(worker, "close_issues", { ids: ["w#1"], fixed_by: "abc123" })).toContain(
      "Closed w#1",
    );
  });

  it("only remove an empty group or module", async () => {
    const { call, lead } = await withModule();
    await call(lead, "write_issues", {
      issues: [{ id: "c#1", module: "hosting", group: "chain", text: "t" }],
    });
    await expect(
      call(lead, "write_issue_group", { module: "hosting", group: "chain", remove: true }),
    ).rejects.toThrow(/still has 1 issues/);
    await call(lead, "close_issues", { ids: ["c#1"], fixed_by: "PR #1" });
    expect(
      await call(lead, "write_issue_group", { module: "hosting", group: "chain", remove: true }),
    ).toBe("Removed group hosting/chain.");
    expect(await call(lead, "write_issue_group", { module: "hosting", remove: true })).toBe(
      "Removed module hosting.",
    );
    await expect(
      call(lead, "write_issues", { issues: [{ module: "nope", text: "t" }] }),
    ).rejects.toThrow(/No module nope/);
  });

  it("refuse to write around an unreadable file or an issue in two modules", async () => {
    const { call, lead, base, manager } = await withModule();
    const dir = path.join(base, ".agent-team", "projects", manager.list()[0].id, "issues");
    await call(lead, "write_issues", { issues: [{ id: "d#1", module: "paths", text: "t" }] });
    fs.writeFileSync(
      path.join(dir, "other.toml"),
      'title = "Other"\n[[issues]]\nid = "d#1"\ntext = "copy"\n',
    );
    await expect(
      call(lead, "write_issues", { issues: [{ id: "d#1", text: "u" }] }),
    ).rejects.toThrow(/in more than one place/);
    fs.writeFileSync(path.join(dir, "other.toml"), "title = ");
    await expect(
      call(lead, "write_issues", { issues: [{ id: "d#1", text: "u" }] }),
    ).rejects.toThrow(/Unreadable issue files: other\.toml/);
    expect(await call(lead, "list_issues")).toContain("- other.toml UNREADABLE");
  });

  it("send the clients a project's issues when the tools or a hand edit change them", async () => {
    const { call, lead, frames, base, manager } = await withModule();
    const pid = manager.list()[0].id;
    frames.splice(0);
    await call(lead, "write_issues", { issues: [{ id: "e#1", module: "paths", text: "t" }] });
    const sent = frames.filter((f) => f.type === "project_issues");
    expect(sent).toHaveLength(1);
    expect(sent[0].projectId).toBe(pid);
    expect(frames.some((f) => f.type === "project_updated")).toBe(false);
    expect(Object.keys(manager.issueSets())).toEqual([pid]);

    frames.splice(0);
    const file = path.join(base, ".agent-team", "projects", pid, "issues", "paths.toml");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf-8").replace('text = "t"', 'text = "by hand"'),
    );
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "project_issues"); i++) await tick();
    const edited = frames.find((f) => f.type === "project_issues") as { modules: IssueModule[] };
    expect(edited.modules.find((m) => m.id === "paths")!.issues[0].text).toBe("by hand");
  });
});

describe("issue edge cases from review", () => {
  async function board() {
    const env = setup();
    const { project, lead } = env.create("clice");
    await env.call(lead, "write_issue_group", { module: "a", title: "A" });
    await env.call(lead, "write_issue_group", { module: "b", title: "B" });
    const dir = path.join(env.base, ".agent-team", "projects", project.id, "issues");
    return { ...env, lead, dir, pid: project.id };
  }
  const today = () => {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  it("keep an issue moved to a module whose file cannot be written", async () => {
    const { call, lead, dir } = await board();
    await call(lead, "write_issues", { issues: [{ id: "x#1", module: "a", text: "t" }] });
    fs.mkdirSync(path.join(dir, `b.toml.${process.pid}.tmp`));
    await expect(
      call(lead, "write_issues", { issues: [{ id: "x#1", module: "b" }] }),
    ).rejects.toThrow();
    const files = ["a", "b"].map((m) => fs.readFileSync(path.join(dir, `${m}.toml`), "utf-8"));
    expect(files.some((t) => t.includes('"x#1"'))).toBe(true);
  });

  it("never give a number twice: not one named later in the batch, nor a closed one, nor one a refused batch took", async () => {
    const { call, lead } = await board();
    const d = today();
    const made = await call(lead, "write_issues", {
      issues: [
        { module: "a", text: "A" },
        { id: `${d}#1`, module: "a", text: "B" },
      ],
    });
    expect(made).toBe(`Created ${d}#2 in a.\nCreated ${d}#1 in a.`);
    await call(lead, "close_issues", { ids: [`${d}#2`, `${d}#1`], fixed_by: "PR #1" });
    await expect(
      call(lead, "write_issues", {
        issues: [
          { module: "a", text: "x" },
          { module: "nope", text: "y" },
        ],
      }),
    ).rejects.toThrow(/No module nope/);
    expect(await call(lead, "write_issues", { issues: [{ module: "a", text: "C" }] })).toBe(
      `Created ${d}#3 in a.`,
    );
  });

  it("refuse an id that would not read back", async () => {
    const { call, lead } = await board();
    await expect(
      call(lead, "write_issues", { issues: [{ id: "\uD800", module: "a", text: "t" }] }),
    ).rejects.toThrow(/id/);
  });

  it("read a file saved with a byte order mark", () => {
    expect(parseModule("m", '﻿title = "B"\n').title).toBe("B");
  });

  it("still read the good modules beside an unreadable one, and say there is one", async () => {
    const { call, lead, dir } = await board();
    await call(lead, "write_issues", { issues: [{ id: "g#1", module: "a", text: "good" }] });
    fs.writeFileSync(path.join(dir, "c.toml"), "title = ");
    expect(await call(lead, "read_issue", { id: "g#1" })).toContain("good");
    await expect(call(lead, "list_issues", { module: "c" })).rejects.toThrow(
      /c\.toml cannot be read/,
    );
    expect(await call(lead, "project_status")).toMatch(/## Issues\n.*1 unreadable/);
  });

  it("take an empty id, module or group for one not given, and refuse unknown fields", async () => {
    const { call, lead } = await board();
    await call(lead, "write_issues", { issues: [{ id: "e#1", module: "a", text: "t" }] });
    expect(
      await call(lead, "write_issues", { issues: [{ id: "e#1", module: "", text: "u" }] }),
    ).toBe("Updated e#1.");
    expect(
      await call(lead, "write_issues", { issues: [{ id: "", module: "a", text: "n" }] }),
    ).toMatch(/^Created \d\d-\d\d#1 in a\.$/);
    expect(await call(lead, "write_issue_group", { module: "a", group: "", notes: "n" })).toBe(
      "Updated module a.",
    );
  });

  it("show a module too large for one listing cut, not left out", async () => {
    const { call, lead } = await board();
    const long = "x".repeat(150);
    await call(lead, "write_issues", {
      issues: Array.from({ length: 500 }, (_, i) => ({ id: `l#${i}`, module: "a", text: long })),
    });
    const list = await call(lead, "list_issues", { module: "a" });
    expect(list).toContain("- l#0 ");
    expect(list).toMatch(/more not shown/);
  });

  it("cap the issues an objective lists", async () => {
    const { call, lead } = await board();
    await call(lead, "write_objective", { id: "x/y", title: "Y", goal: "g" });
    await call(lead, "write_issue_group", { module: "a", objectives: ["x/y"] });
    await call(lead, "write_issues", {
      issues: Array.from({ length: 50 }, (_, i) => ({ id: `o#${i}`, module: "a", text: "t" })),
    });
    const read = await call(lead, "read_objective", { id: "x/y" });
    expect(read.split("\n").filter((l) => l.startsWith("- o#"))).toHaveLength(30);
    expect(read).toContain("(20 more: list_issues with objective x/y)");
  });

  it("see hand edits after the issues dir is replaced whole", async () => {
    const { manager, frames, dir } = await board();
    manager.issueSets();
    const fresh = `${dir}.new`;
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, "c.toml"), 'title = "C"\n');
    fs.rmSync(dir, { recursive: true });
    fs.renameSync(fresh, dir);
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "project_issues"); i++) await tick();
    frames.splice(0);
    for (let i = 0; i < 60; i++) await tick();
    fs.writeFileSync(path.join(dir, "d.toml"), 'title = "D"\n');
    const seen = () =>
      frames.some(
        (f) =>
          f.type === "project_issues" && (f.modules as IssueModule[]).some((m) => m.id === "d"),
      );
    for (let i = 0; i < 100 && !seen(); i++) await tick();
    expect(seen()).toBe(true);
  });

  it("never fail a client's connect over an issues path that is a file", () => {
    const env = setup();
    const { project } = env.create("x");
    fs.writeFileSync(path.join(env.base, ".agent-team", "projects", project.id, "issues"), "");
    expect(() => env.manager.issueSets()).not.toThrow();
  });

  it("watch a new project's issues from the start", async () => {
    const env = setup();
    const { project } = env.create("x");
    const dir = path.join(env.base, ".agent-team", "projects", project.id, "issues");
    for (let i = 0; i < 60; i++) await tick();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "c.toml"), 'title = "C"\n');
    const seen = () => env.frames.some((f) => f.type === "project_issues");
    for (let i = 0; i < 100 && !seen(); i++) await tick();
    expect(seen()).toBe(true);
  });

  it("report a module dir inside issues/ instead of passing over it", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "a.toml"), 'title = "A"\n');
    expect(new IssueStore(dir).list()).toEqual([
      { id: "out", error: expect.stringMatching(/directory/) as string },
    ]);
  });

  it("do not echo the tools' own writes back from the watcher", async () => {
    const { call, lead, frames } = await board();
    for (let i = 0; i < 60; i++) await tick();
    frames.splice(0);
    await call(lead, "write_issues", { issues: [{ id: "n#1", module: "a", text: "t" }] });
    for (let i = 0; i < 80; i++) await tick();
    expect(frames.filter((f) => f.type === "project_issues")).toHaveLength(1);
  });
});
