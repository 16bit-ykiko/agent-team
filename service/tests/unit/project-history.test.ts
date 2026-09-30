// Every folder is part of a project; the workspaces from before projects
// are its history, which the lead can search and read.
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
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
    const agent = [...inRepo.agents.values()][0];
    agent.session.sessionId = "abc";

    const listed = await call(lead, "list_history");
    expect(listed).toContain(`${inRepo.id} "parser work" in ${root}`);
    expect(listed).toContain('"sub"');
    expect(listed).not.toContain("elsewhere");
    expect(listed).toContain(
      `transcript: ${path.join(os.homedir(), ".claude", "projects", root.replace(/[/.]/g, "-"), "abc.jsonl")}`,
    );
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

  it("do not reach into another project's sessions, live or archived", async () => {
    const { create, call, workers } = setup();
    const a = create("a");
    const b = create("b");
    await call(b.lead, "start_session", { title: "theirs", cwd: "wt", task: "t" });
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
  });
});
