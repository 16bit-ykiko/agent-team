import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { ProjectStore } from "../../src/project/store";
import { leadToolset, workerToolset, type PanelApi } from "../../src/project/tools";
import { SETTLE_MS, START_SPACING_MS, awaitsUser } from "../../src/project/manager";
import { Workspace } from "../../src/workspace/workspace";
import { historyOf, saveIndex, saveWorkspace, loadAll } from "../../src/workspace/state";
import { summarizeMessages } from "../../src/workspace/summary";
import { FakeHost, FakeSession } from "./fakes";
import { HostRegistry } from "../../src/session/host";
import { setupProjects as setup, tick, tmpDir as tmp, withTask } from "./projectHarness";

describe("ProjectStore", () => {
  it("persists projects outside the repository and removes them whole", () => {
    const base = tmp();
    const store = new ProjectStore(base);
    const p = store.create("clice", "/repo/clice");
    p.leadWorkspaceId = "ws-lead";
    store.save(p);
    expect(fs.existsSync(store.notesDir(p.id))).toBe(true);
    expect(fs.existsSync(store.objectivesDir(p.id))).toBe(true);

    const reopened = new ProjectStore(base);
    expect(reopened.list()).toEqual([p]);
    reopened.remove(p.id);
    expect(reopened.list()).toEqual([]);
    expect(fs.existsSync(reopened.notesDir(p.id))).toBe(false);
  });
});

describe("panel tool arguments", () => {
  const project = { id: "p1", name: "clice", root: "/repo", leadWorkspaceId: "ws-l", createdAt: 1 };
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...a: unknown[]) => {
      calls.push([name, ...a]);
      return "ok";
    };
  const api: PanelApi = {
    projectStatus: (...a) => Promise.resolve(record("projectStatus")(...a)),
    startSession: record("startSession"),
    readSession: (...a) => Promise.resolve(record("readSession")(...a)),
    listHistory: (...a) => Promise.resolve(record("listHistory")(...a)),
    searchHistory: (...a) => Promise.resolve(record("searchHistory")(...a)),
    readEntry: (...a) => Promise.resolve(record("readEntry")(...a)),
    queryHistory: (...a) => Promise.resolve(record("queryHistory")(...a)),
    messageSession: record("messageSession"),
    stopSession: record("stopSession"),
    archiveSession: record("archiveSession"),
    listObjectives: record("listObjectives"),
    readObjective: record("readObjective"),
    writeObjective: record("writeObjective"),
    addItems: record("addItems"),
    updateItem: record("updateItem"),
    deleteObjective: record("deleteObjective"),
    archiveObjective: record("archiveObjective"),
    restoreObjective: record("restoreObjective"),
    listProjects: record("listProjects"),
    messageProject: record("messageProject"),
    workerReport: record("workerReport"),
    currentTask: record("currentTask"),
  };
  const byName = (tools: ReturnType<typeof leadToolset>) =>
    Object.fromEntries(tools.tools.map((t) => [t.name, t]));

  afterEach(() => void calls.splice(0));

  it("map onto the project's API", async () => {
    const t = byName(leadToolset(api, project, "/notes", ["m"]));
    await t.start_session.handler({
      title: "modules",
      cwd: "../clice-modules",
      task: "do it",
      objective_id: "core/modules",
      task_id: "t2",
    });
    await t.read_session.handler({ session_id: "ws-w" });
    await t.search_history.handler({
      query: "PartialSpec",
      in: ["tool_output"],
      tool: "Bash",
      since: "2026-09-01",
      level: "subagents",
      limit: 5,
      offset: 10,
    });
    await t.read_entry.handler({ entry: 12 });
    await t.query_history.handler({ sql: "select 1" });
    await t.write_objective.handler({
      id: "core/modules",
      status: "later",
      reason: "after the index",
      depends_on: ["index/format"],
    });
    await t.add_items.handler({ objective_id: "core/modules", decisions: ["which std?"] });
    await t.update_item.handler({ objective_id: "core/modules", item_id: "d1", outcome: "C++20" });
    await t.message_project.handler({ project_id: "p2", message: "hi" });
    expect(calls).toEqual([
      [
        "startSession",
        "p1",
        {
          title: "modules",
          cwd: "../clice-modules",
          task: "do it",
          objectiveId: "core/modules",
          taskId: "t2",
        },
      ],
      ["readSession", "p1", "ws-w", 6, undefined, false, false],
      [
        "searchHistory",
        "p1",
        {
          query: "PartialSpec",
          in: ["tool_output"],
          tool: "Bash",
          since: Date.parse("2026-09-01"),
          level: "subagents",
          caseSensitive: false,
          everywhere: false,
          limit: 5,
          offset: 10,
        },
      ],
      ["readEntry", "p1", 12, 1, 200, 0],
      ["queryHistory", "p1", "select 1"],
      [
        "writeObjective",
        "p1",
        {
          id: "core/modules",
          status: "later",
          reason: "after the index",
          dependsOn: ["index/format"],
        },
      ],
      ["addItems", "p1", "core/modules", [], ["which std?"]],
      ["updateItem", "p1", "core/modules", "d1", { outcome: "C++20" }],
      ["messageProject", "p1", "p2", "hi"],
    ]);
  });

  it("route a worker's reports to its own workspace", async () => {
    const t = byName(workerToolset(api, "ws-w", project));
    await t.report_progress.handler({ text: "tests pass" });
    // There is no blocked report: a decision goes to the user in the worker's own session.
    await t.finish_task.handler({ summary: "merged", blocked: true });
    expect(calls).toEqual([
      ["workerReport", "ws-w", "tests pass", false],
      ["workerReport", "ws-w", "merged", true],
    ]);
    expect(Object.keys(t.finish_task.shape)).toEqual(["summary"]);
  });

  it("turn a thrown error into a rejection", async () => {
    const failing: PanelApi = {
      ...api,
      stopSession: () => {
        throw new Error("No session ws-x in this project");
      },
    };
    const t = byName(leadToolset(failing, project, "/notes", ["m"]));
    await expect(t.stop_session.handler({ session_id: "ws-x" })).rejects.toThrow("No session ws-x");
  });
});

describe("ProjectManager", () => {
  it("creates a lead on Opus with the lead's tools", () => {
    const { create, session } = setup();
    const { lead, project } = create("clice");
    expect(lead.projectLink).toEqual({ projectId: project.id, role: "lead" });
    expect(lead.name).toBe("clice · lead");
    expect([...lead.agents.values()][0].info.model).toBe("claude-opus-5-5");
    const tools = session(lead).panelTools!.tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(["start_session", "archive_session", "message_project"]),
    );
  });

  it("starts a worker in a worktree folder and hands it the task", async () => {
    const { create, call, session, workspaces, root, objectives } = setup();
    const { lead, project } = create("clice");
    await withTask(call, lead);

    const reply = await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "implement it",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    expect(reply).toContain(`Started session ${worker.id}`);
    expect(worker.cwd).toBe(path.join(root, "wt"));
    expect(worker.projectLink).toEqual({ projectId: project.id, role: "worker" });
    expect(session(worker).sent).toEqual(["[From the project lead]\n\nimplement it"]);
    expect(worker.messages.find((m) => m.kind === "user")).toMatchObject({
      content: "implement it",
      from: { role: "lead" },
    });
    expect(objectives()[0]).toMatchObject({
      sessions: [worker.id],
      tasks: [{ id: "t1", state: "doing", session: worker.id }],
    });
  });

  it("refuses bad input before creating anything", async () => {
    const { create, call, workspaces } = setup();
    const { lead } = create("clice");
    await expect(
      call(lead, "start_session", { title: "x", cwd: "nope", task: "t" }),
    ).rejects.toThrow("worktree add");
    await expect(
      call(lead, "start_session", { title: "x", cwd: "wt", task: "t", model: "gpt-5" }),
    ).rejects.toThrow("Unknown model gpt-5");
    await expect(
      call(lead, "start_session", { title: "x", cwd: "wt", task: "t", objective_id: "core/x" }),
    ).rejects.toThrow("No objective core/x");
    await withTask(call, lead);
    await expect(
      call(lead, "start_session", {
        title: "x",
        cwd: "wt",
        task: "t",
        objective_id: "core/modules",
        task_id: "t9",
      }),
    ).rejects.toThrow("No task t9 in core/modules");
    expect(workspaces.size).toBe(1);
  });

  it("tells a worker what it is on, as it stands: the task, the lead's word since, its objective", async () => {
    const { create, call, workspaces } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "add_items", { objective_id: "core/modules", decisions: ["which std?"] });
    await call(lead, "write_objective", { id: "core/lexer", title: "Lexer", goal: "tokens" });
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "Implement C++20 modules in the scanner.",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    await call(lead, "update_item", {
      objective_id: "core/modules",
      item_id: "d1",
      outcome: "C++20",
    });
    await call(lead, "message_session", { session_id: worker.id, message: "Skip header units." });

    const now = await call(worker, "current_task");
    expect(now).toContain(`You are session ${worker.id} "modules"`);
    expect(now).toContain("Implement C++20 modules in the scanner.");
    expect(now).toContain("Later from the lead");
    expect(now).toContain("Skip header units.");
    expect(now).toContain("core/modules — Modules");
    expect(now).toContain(`- t1 [doing] implement (session ${worker.id})`);
    expect(now).toContain("- d1 settled: which std? → C++20");
    expect(now).not.toContain("core/lexer");
    // Another objective, by id.
    expect(await call(worker, "current_task", { objective_id: "core/lexer" })).toContain(
      "core/lexer — Lexer",
    );
  });

  it("delivers a worker's report to the lead and moves its task to review", async () => {
    const { create, call, session, workspaces, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "modules",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;

    // The lead is busy: the report waits in its queue.
    session(lead).isRunning = true;
    await call(worker, "finish_task", { summary: "done on branch modules" });
    await tick();
    expect(session(lead).sent).toEqual([]);
    const report = lead.messages.find((m) => m.from?.role === "worker")!;
    expect(report).toMatchObject({
      status: "queued",
      content: "Finished:\n\ndone on branch modules",
      from: { workspaceId: worker.id, name: "modules" },
    });
    expect(objectives()[0].tasks[0].state).toBe("review");
  });

  it("lets leads message each other without waiting", async () => {
    const { create, call, session } = setup();
    const a = create("clice");
    const b = create("clangd");
    expect(await call(a.lead, "list_projects")).toContain(`${b.project.id} "clangd"`);
    const reply = await call(a.lead, "message_project", {
      project_id: b.project.id,
      message: "which LSP version?",
    });
    expect(reply).toContain('Sent to the lead of "clangd"');
    expect(session(b.lead).sent[0]).toContain(`(${a.project.id}). If they ask for something`);
    expect(b.lead.messages.find((m) => m.from)!.from).toEqual({
      workspaceId: a.lead.id,
      name: "clice",
      role: "peer",
      projectId: a.project.id,
    });
    await expect(
      call(a.lead, "message_project", { project_id: a.project.id, message: "x" }),
    ).rejects.toThrow("That is this project");
  });

  it("archives only an idle worker", async () => {
    const { create, call, session, workspaces } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    await expect(call(lead, "archive_session", { session_id: worker.id })).rejects.toThrow(
      "still working",
    );
    // The turn ends.
    session(worker).isRunning = false;
    session(worker).emit("event", { kind: "result", content: "" });
    expect(await call(lead, "archive_session", { session_id: worker.id })).toBe('Archived "w".');
    expect(worker.isArchived).toBe(true);
  });

  it("renames the project, its lead and the tools' instructions", () => {
    const { create, manager, session, frames } = setup();
    const { lead, project } = create("clice");
    manager.rename(project.id, "clice2");
    expect(lead.name).toBe("clice2 · lead");
    expect(session(lead).panelTools!.instructions).toContain('project "clice2"');
    expect(frames).toContainEqual({ type: "workspace_updated", id: lead.id });
  });

  it("deletes the project and its lead, leaving its sessions as plain workspaces", async () => {
    const { create, call, manager, session, workspaces, frames } = setup();
    const { lead, project } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    manager.delete(project.id);
    expect(workspaces.has(lead.id)).toBe(false);
    expect(worker.projectLink).toBeUndefined();
    expect(session(worker).panelTools).toBeNull();
    expect(manager.list()).toEqual([]);
    expect(frames).toContainEqual({ type: "project_deleted", projectId: project.id });
  });

  it("forgets a deleted worker in the objectives", async () => {
    const { create, call, manager, workspaces, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const worker = [...workspaces.values()].find((w) => w.projectLink?.role === "worker")!;
    manager.forget(worker);
    expect(objectives()[0].sessions).toEqual([]);
    expect(objectives()[0].tasks[0].session).toBeUndefined();
  });
});

describe("project messages that must not be lost or looped", () => {
  it("fail the tool when the target has no agent, before touching the board", async () => {
    const { create, call, workers, manager, objectives } = setup();
    const { lead } = create("clice");
    await withTask(call, lead);
    await call(lead, "start_session", {
      title: "w",
      cwd: "wt",
      task: "t",
      objective_id: "core/modules",
      task_id: "t1",
    });
    const [worker] = workers();
    lead.removeAgent([...lead.agents.keys()][0]);

    await expect(call(worker, "finish_task", { summary: "done" })).rejects.toThrow("has no agent");
    expect(objectives()[0].tasks[0].state).toBe("doing");
    worker.removeAgent([...worker.agents.keys()][0]);
    const tools = manager.toolsFor(lead)!.tools;
    await expect(
      tools
        .find((t) => t.name === "message_session")!
        .handler({ session_id: worker.id, message: "x" }),
    ).rejects.toThrow("has no agent");
  });

  it("wait out a rate-limit pause instead of replacing the prompt to retry", async () => {
    const registry = new HostRegistry();
    const fake = new FakeHost();
    registry.register(fake);
    const ws = new Workspace("ws-x", "w", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    const agent = ws.addAgent("A", "claude-opus-5-5[1m]", "a", "c", { backend: "claude" });
    const s = fake.lastSession!;
    await ws.sendMessage("P1");
    s.isRunning = false;
    s.emit("event", { kind: "error", content: "Usage limit reached (five-hour)." });
    ws.pauseAgent(agent.id, Date.now() + 3600_000, true);

    expect(ws.deliver("report", { workspaceId: "w2", name: "w2", role: "worker" }, "REPORT")).toBe(
      "queued",
    );
    expect(s.sent).toEqual(["P1"]);
    expect(ws.retryLast(agent.id)).toBe(true);
    expect(s.sent).toEqual(["P1", "P1"]);
    s.isRunning = false;
    s.emit("event", { kind: "result", content: "" });
    await tick();
    expect(s.sent).toEqual(["P1", "P1", "REPORT"]);
  });

  it("stop two leads from answering each other forever", async () => {
    const { create, call, session } = setup();
    const a = create("a");
    const b = create("b");
    const send = (from: typeof a, to: typeof b) => {
      session(to.lead).isRunning = false;
      return call(from.lead, "message_project", { project_id: to.project.id, message: "m" });
    };
    for (let i = 0; i < 3; i++) {
      await send(a, b);
      await send(b, a);
    }
    await expect(send(a, b)).rejects.toThrow("stop here and tell the user");
    expect(session(b.lead).sent.at(-1)).toContain("otherwise no reply is needed");
  });

  it("space out worker starts so a lead cannot burst sessions", async () => {
    vi.useFakeTimers();
    try {
      const { create, call, workers, session } = setup();
      const { lead } = create("a");
      for (let i = 0; i < 3; i++) {
        await call(lead, "start_session", { title: `w${i}`, cwd: "wt", task: "t" });
      }
      const sent = () => workers().map((w) => session(w).sent.length);
      expect(sent()).toEqual([1, 0, 0]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(sent()).toEqual([1, 1, 0]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(sent()).toEqual([1, 1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project edge cases", () => {
  it("default workers to a Claude model even when the lead workspace has a Codex agent first", async () => {
    const { create, workers, manager } = setup();
    const { lead } = create("a");
    const claudeLead = [...lead.agents.keys()][0];
    lead.addAgent("Cx", "gpt-6-astra", "c", "c", { backend: "codex" });
    lead.removeAgent(claudeLead);
    const start = manager.toolsFor(lead)!.tools.find((t) => t.name === "start_session")!;
    expect(await start.handler({ title: "w", cwd: "wt", task: "t" })).toContain(
      "on claude-opus-5-5",
    );
    expect([...workers()[0].agents.values()][0].info.model).toBe("claude-opus-5-5");
  });

  it("default workers to Opus 5.5 whatever model the lead was switched to", async () => {
    const { create, workers, manager } = setup();
    const { lead } = create("a");
    const [agent] = lead.agents.values();
    agent.info.model = "claude-fable-5-1";
    const start = manager.toolsFor(lead)!.tools.find((t) => t.name === "start_session")!;
    expect((start.shape.model as z.ZodString).description).toContain("defaults to claude-opus-5-5");
    expect(await start.handler({ title: "w", cwd: "wt", task: "t" })).toContain(
      "on claude-opus-5-5",
    );
    await start.handler({ title: "f", cwd: "wt", task: "t", model: "claude-fable-5-1" });
    expect(workers().map((w) => [...w.agents.values()][0].info.model)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
  });

  it("refuse board updates for a deleted project instead of recreating its folder", async () => {
    const { base, create, manager } = setup();
    const { lead, project } = create("a");
    const tools = manager.toolsFor(lead)!.tools;
    manager.delete(project.id);
    await expect(
      tools
        .find((t) => t.name === "write_objective")!
        .handler({ id: "core/late", title: "late", goal: "g" }),
    ).rejects.toThrow(`No project ${project.id}`);
    expect(fs.existsSync(path.join(base, ".agent-team", "projects", project.id))).toBe(false);
  });

  it("save renamed and unlinked workspaces right away", async () => {
    const { create, call, manager, workers, saved } = setup();
    const { lead, project } = create("a");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    manager.rename(project.id, "b");
    expect(saved).toEqual([lead.id]);
    manager.delete(project.id);
    expect(saved).toEqual([lead.id, worker.id]);
  });

  it("show a worker's cut-off turn in the project status", async () => {
    const { create, call, workers, registry } = setup();
    const { lead } = create("a");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const worker = workers()[0];
    // A restart mid-turn marks the reply interrupted.
    const restored = Workspace.fromState(worker.getState(), registry);
    const reply = restored.messages.find((m) => m.kind === "agent")!;
    worker.messages.find((m) => m.kind === "agent")!.content = reply.content;
    expect(await call(lead, "project_status")).toContain("its last turn did not finish");
  });
});

describe("project messages across a restart", () => {
  it("keep a queued report's sender and prompt", async () => {
    const { create, call, session, workers, registry, base } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    session(lead).isRunning = true;
    await call(worker, "finish_task", { summary: "done" });

    saveWorkspace(base, lead.getState());
    saveIndex(base, [lead.id]);
    const [state] = loadAll(base);
    expect(state.projectLink).toEqual(lead.projectLink);
    const restored = Workspace.fromState(state, registry);
    const queued = restored.messages.find((m) => m.status === "queued")!;
    expect(queued.from).toMatchObject({ role: "worker", workspaceId: worker.id });
    expect(summarizeMessages([queued])[0].from).toEqual(queued.from);
    restored.dequeueNext([...restored.agents.keys()][0]);
    const s = [...restored.agents.values()][0].session as FakeSession;
    expect(s.sent).toEqual([`[From session "w" (${worker.id})]\n\nFinished:\n\ndone`]);
  });
});

describe("message_session and read_session", () => {
  it("queue behind a busy worker and say so", async () => {
    const { create, call, session, workers, endTurn } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "first task" });
    const [worker] = workers();
    expect(
      await call(lead, "message_session", { session_id: worker.id, message: "tests too" }),
    ).toBe('Sent to "w" (queued: it is busy).');
    endTurn(worker);
    await tick();
    expect(session(worker).sent).toEqual([
      "[From the project lead]\n\nfirst task",
      "[From the project lead]\n\ntests too",
    ]);
  });

  it("refuse the lead itself and other projects' sessions", async () => {
    const { create, call, workers } = setup();
    const a = create("a");
    const b = create("b");
    await call(b.lead, "start_session", { title: "theirs", cwd: "wt", task: "t" });
    const [other] = workers();
    for (const id of [a.lead.id, other.id]) {
      await expect(
        call(a.lead, "message_session", { session_id: id, message: "x" }),
      ).rejects.toThrow(`No session ${id} in this project`);
    }
  });

  it("label senders, count tool calls and cut long replies", async () => {
    const { create, call, session, workers, endTurn } = setup();
    const { lead } = create("clice");
    await call(lead, "start_session", { title: "w", cwd: "wt", task: "t" });
    const [worker] = workers();
    session(worker).emit("event", {
      kind: "tool_use",
      content: "**Bash**",
      toolName: "Bash",
      toolUseId: "t1",
    });
    session(worker).emit("event", { kind: "text_delta", content: "x".repeat(3500) });
    endTurn(worker);
    await tick();
    await worker.sendMessage("user typed this");
    const out = await call(lead, "read_session", { session_id: worker.id, last: 10 });
    const agentName = [...worker.agents.values()][0].info.name;
    const headers = out.split("\n").filter((l) => l.startsWith("--- "));
    expect(headers.map((h) => h.split(" · ")[0])).toEqual([
      "--- Lead",
      `--- ${agentName}`,
      "--- user",
      `--- ${agentName}`,
    ]);
    // The message id, for reading around it later.
    expect(headers[1]).toMatch(/ · done · 1 tool calls · msg-\S+$/);
    expect(out).toContain("x".repeat(3000) + " …(truncated)");
    const last1 = await call(lead, "read_session", { session_id: worker.id, last: 1 });
    expect(last1.split("\n").filter((l) => l.startsWith("--- "))).toHaveLength(1);
  });
});

describe("rate-limit retries", () => {
  // A worker whose lead task just hit a rate limit, its retry pending.
  const limited = async () => {
    const h = setup();
    const { lead } = h.create("a");
    await h.call(lead, "start_session", { title: "w", cwd: "wt", task: "build it" });
    const w = h.workers()[0];
    const [agentId] = w.agents.keys();
    const s = h.session(w);
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.isRunning = false;
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    return { ...h, lead, w, agentId, s };
  };

  it("are dropped by a stop, the lead's or the user's, a cleared context and an archive", async () => {
    for (const stop of ["lead", "user", "clear", "archive"] as const) {
      const { lead, w, agentId, s, call } = await limited();
      if (stop === "lead") await call(lead, "stop_session", { session_id: w.id });
      if (stop === "user") w.abortAll();
      if (stop === "clear") w.clearContext(agentId);
      if (stop === "archive") await call(lead, "archive_session", { session_id: w.id });
      expect(w.retryLast(agentId), stop).toBe(false);
      expect(w.getState().agents[0].pausedUntil, stop).toBeUndefined();
      expect(s.sent, stop).toHaveLength(1);
    }
  });

  it("never re-send a prompt already answered when a turn the CLI started hits the limit", async () => {
    const { w, s, call, endTurn } = await limited();
    const [agentId] = w.agents.keys();
    expect(w.retryLast(agentId)).toBe(true);
    await call(w, "finish_task", { summary: "built" });
    endTurn(w);
    // A wake-up after a background task, then the limit.
    s.emit("event", { kind: "text_delta", content: "checking the build" });
    w.pauseAgent(agentId, Date.now() + 3600_000, true);
    s.emit("event", { kind: "error", content: "Usage limit reached" });
    expect(w.retryLast(agentId)).toBe(false);
    expect(s.sent).toHaveLength(2);
  });

  it("go ahead of what comes in meanwhile: the lead's message waits, the user's is the cue to retry now", async () => {
    vi.useFakeTimers();
    try {
      const { lead, w, agentId, s, call, endTurn } = await limited();
      // Past the reset, the retry not yet fired (a restart's ladder).
      w.pauseAgent(agentId, Date.now() - 1, true);
      await call(lead, "message_session", { session_id: w.id, message: "also Y" });
      expect(s.sent).toHaveLength(1);
      expect(w.retryLast(agentId)).toBe(true);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(1)).toEqual([
        "[From the project lead]\n\nbuild it",
        "[From the project lead]\n\nalso Y",
      ]);

      w.pauseAgent(agentId, Date.now() + 3600_000, true);
      s.isRunning = false;
      await w.sendMessage("U");
      expect(s.sent.slice(3)).toEqual(["[From the project lead]\n\nalso Y"]);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(4)).toEqual(["U"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep their prompt through a turn the CLI starts itself while they wait", async () => {
    const { w, agentId, s, endTurn } = await limited();
    s.isRunning = true;
    s.emit("event", {
      kind: "notice",
      level: "wakeup",
      content: "A background task reported back — resumed to handle its result.",
    });
    endTurn(w);
    expect(w.retryLast(agentId)).toBe(true);
    expect(s.sent).toEqual([
      "[From the project lead]\n\nbuild it",
      "[From the project lead]\n\nbuild it",
    ]);
  });

  it("are not used up by the user writing while a turn still runs", async () => {
    vi.useFakeTimers();
    try {
      const { w, agentId, s, endTurn } = await limited();
      s.isRunning = true;
      await w.sendMessage("U");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent).toHaveLength(1);
      expect(w.retryLast(agentId)).toBe(true);
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.sent.slice(1)).toEqual(["[From the project lead]\n\nbuild it", "U"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worker tasks held back for spacing", () => {
  const twoStarts = async () => {
    const env = setup();
    const { lead } = env.create("a");
    await env.call(lead, "start_session", { title: "w0", cwd: "wt", task: "first" });
    const reply = await env.call(lead, "start_session", { title: "w1", cwd: "wt", task: "second" });
    const w1 = env.workers().find((w) => w.name === "w1")!;
    return { ...env, lead, reply, w1 };
  };

  it("wait as a saved queued message and go out after the gap, or after a restart", async () => {
    vi.useFakeTimers();
    try {
      const { reply, w1, session, registry } = await twoStarts();
      expect(reply).toContain("Its task goes out in 15 s");
      const task = w1.messages.find((m) => m.kind === "user")!;
      expect(task).toMatchObject({ status: "queued", content: "second", from: { role: "lead" } });
      const restored = Workspace.fromState(w1.getState(), registry);
      expect(restored.messages.find((m) => m.status === "queued")?.queuedPrompt).toBe(
        "[From the project lead]\n\nsecond",
      );
      expect(session(w1).sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual(["[From the project lead]\n\nsecond"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leave nothing to retry once sent, so a restart sends nothing again", async () => {
    vi.useFakeTimers();
    try {
      const { w1, session, endTurn, registry } = await twoStarts();
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      endTurn(w1);
      const saved = w1.getState().agents[0];
      expect([saved.pausedUntil, saved.lastPrompt]).toEqual([undefined, undefined]);
      const restored = Workspace.fromState(w1.getState(), registry);
      expect([...restored.agents.values()][0].retryPending).toBe(false);
      expect(session(w1).sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("space the lead's messages that wake idle workers", async () => {
    vi.useFakeTimers();
    try {
      const { w1, lead, call, session, endTurn, workers } = await twoStarts();
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      const w0 = workers().find((w) => w.name === "w0")!;
      endTurn(w0);
      endTurn(w1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(await call(lead, "message_session", { session_id: w0.id, message: "go on" })).toBe(
        'Sent to "w0".',
      );
      expect(await call(lead, "message_session", { session_id: w1.id, message: "go on" })).toBe(
        'Sent to "w1"; it goes out in 15 s: starts are spaced out.',
      );
      expect(session(w1).sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([
        "[From the project lead]\n\nsecond",
        "[From the project lead]\n\ngo on",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("go out even when their timer fires a millisecond early", async () => {
    vi.useFakeTimers();
    try {
      const { w1, session } = await twoStarts();
      vi.setSystemTime(Date.now() - 1);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual(["[From the project lead]\n\nsecond"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pass a queued lead message on to the agent that takes over from a removed one", async () => {
    const { w1 } = await twoStarts();
    const [first] = w1.agents.keys();
    const b = w1.addAgent("B", "claude-opus-5-5", "b", "c", { backend: "claude" });
    expect(w1.removeAgent(first)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    const heir = w1.agents.get(b.id)!.session as FakeSession;
    expect(heir.sent).toEqual(["[From the project lead]\n\nsecond"]);
  });

  it("keep a lead message passed on to the agent that takes over through a crash", async () => {
    const { w1, base, registry } = await twoStarts();
    const [first] = w1.agents.keys();
    const b = w1.addAgent("B", "claude-opus-5-5", "b", "c", { backend: "claude" });
    (w1.agents.get(b.id)!.session as FakeSession).isRunning = true;
    // As the server saves: the messages it was told changed, and new ones.
    const save = () => historyOf(base).save(w1.id, w1.getMessages(), w1.takeChanged());
    save();
    expect(w1.removeAgent(first)).toEqual([]);
    save();
    const back = Workspace.fromState(
      { ...w1.getState(), messages: historyOf(base).load(w1.id) },
      registry,
    );
    expect(back.messages.find((m) => m.status === "queued")).toMatchObject({
      content: "second",
      queuedFor: b.id,
    });
  });

  it("are not held back by a restart's checks on the workers that owe their lead a word", async () => {
    vi.useFakeTimers();
    try {
      const { create, call, manager, workers } = setup();
      const { lead } = create("a");
      for (let i = 0; i < 8; i++) {
        await call(lead, "start_session", { title: `w${i}`, cwd: "wt", task: `t${i}` });
      }
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(workers().every((w) => !w.lastDelivered()[0].answered)).toBe(true);
      manager.recheckWorkers();
      expect(await call(lead, "start_session", { title: "x", cwd: "wt", task: "x" })).not.toContain(
        "goes out in",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stay ahead of a follow-up sent in the meantime", async () => {
    vi.useFakeTimers();
    try {
      const { w1, lead, call, session, endTurn } = await twoStarts();
      expect(await call(lead, "message_session", { session_id: w1.id, message: "also X" })).toBe(
        'Sent to "w1" (queued: it is busy).',
      );
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      endTurn(w1);
      await vi.advanceTimersByTimeAsync(10);
      expect(session(w1).sent).toEqual([
        "[From the project lead]\n\nsecond",
        "[From the project lead]\n\nalso X",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are dropped by stop_session", async () => {
    vi.useFakeTimers();
    try {
      const { w1, lead, call, session, frames } = await twoStarts();
      await call(lead, "stop_session", { session_id: w1.id });
      expect(w1.messages.some((m) => m.status === "queued")).toBe(false);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "message_removed", workspaceId: w1.id }),
      );
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are dropped with their project", async () => {
    vi.useFakeTimers();
    try {
      const { w1, session, manager, lead } = await twoStarts();
      manager.delete(lead.projectLink!.projectId);
      expect(w1.projectLink).toBeUndefined();
      expect(w1.messages.some((m) => m.status === "queued")).toBe(false);
      await vi.advanceTimersByTimeAsync(START_SPACING_MS);
      expect(session(w1).sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a worker that goes idle without reporting", () => {
  // A lead with one worker running the task it was given.
  const started = async () => {
    const h = setup();
    const { lead, project } = h.create("a");
    await h.call(lead, "start_session", { title: "w", cwd: "wt", task: "do it" });
    const w = h.workers()[0];
    const say = (text: string, to = w) =>
      h.session(to).emit("event", { kind: "text_delta", content: text });
    const told = () =>
      lead
        .getMessages()
        .filter((m) => m.from?.workspaceId === w.id)
        .map((m) => m.content);
    const settle = () => vi.advanceTimersByTimeAsync(SETTLE_MS);
    const ask = (message: string) => h.call(lead, "message_session", { session_id: w.id, message });
    // The lead's message queued behind the task, which then ends and lets it run.
    const askNext = async (message: string) => {
      await ask(message);
      h.endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
    };
    const state = (s: string) => h.session(w).emit("runState", s);
    return { ...h, lead, project, w, say, told, settle, ask, askNext, state };
  };
  const CARRY_ON =
    "[From the panel] A server restart cut your turn off. Carry on where you left off.";
  const note = (how: string, message: string, reply?: string) =>
    [`No report on your message "${message}" (${how}).`, reply && `Its last reply:\n\n${reply}`]
      .filter(Boolean)
      .join("\n\n");

  it("leaves a task that ends in a question to the user, across a restart too", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, restart, manager } = await started();
      say("Which branch should this go on?");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0].answered).toBe(true);
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(back.lastDelivered()[0].answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the lead once, with the last reply, when its later message is answered without a report", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext } = await started();
      await askNext("which branch is it on?");
      say("feature/x");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      expect(told()).toEqual([]);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which branch is it on?", "feature/x")]);
      // A wake-up turn after it (a background task) is no new work from the lead.
      say("late output");
      endTurn(w);
      await settle();
      expect(told()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the wait from the last thing the worker did", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, endTurn, ask } = await started();
      await ask("also this");
      say("first");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      say("second");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
      expect(told()).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(told()).toEqual([note("its turn ended", "also this", "second")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not tell in the gap between a background task's end and the turn it starts", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext, state } = await started();
      await askNext("run the build");
      // Timings from the claude/bash-bg recording.
      say("started");
      state("waiting");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(4008);
      state("idle");
      await vi.advanceTimersByTimeAsync(1861);
      state("working");
      await settle();
      expect(told()).toEqual([]);
      say("the output says done");
      endTurn(w);
      state("idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "run the build", "the output says done")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing more once it finished, but a progress report is not one", async () => {
    vi.useFakeTimers();
    try {
      const { w, call, say, told, settle, endTurn, ask } = await started();
      say("Done.");
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      await settle();
      expect(told()).toEqual(["Finished:\n\nmerged"]);

      // A follow-up queued behind the turn that reported is owed its own.
      await ask("the API docs");
      await ask("and the README");
      await call(w, "finish_task", { summary: "API docs written" });
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      await call(w, "report_progress", { text: "README half done" });
      say("Stopping here for now.");
      endTurn(w);
      await settle();
      expect(told().slice(1)).toEqual([
        "Finished:\n\nAPI docs written",
        "Progress:\n\nREADME half done",
        note("its turn ended", "and the README", "Stopping here for now."),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells how a failed turn ended, and leaves one the user stopped to them", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, ask, state } = await started();
      say("Working on it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(told()).toEqual([
        note("its turn failed: API Error: 529 overloaded", "do it", "Working on it"),
      ]);

      await ask("try again");
      say("Retrying");
      session(w).isRunning = false;
      w.abortAll();
      await settle();
      expect(w.lastDelivered()[0]).toMatchObject({ stopped: "user", answered: true });

      // Stopped while it waited on a background task, its turn long over.
      await ask("run the benchmark");
      say("Started it in the background.");
      state("waiting");
      endTurn(w);
      w.abortAll();
      state("idle");
      await settle();
      expect(w.lastDelivered()[0]).toMatchObject({ stopped: "user", answered: true });

      // Context cleared under a background task: a stop too.
      await ask("profile it");
      say("Profiling in the background.");
      state("waiting");
      endTurn(w);
      w.clearContext([...w.agents.keys()][0]);
      state("idle");
      await settle();
      expect(told()).toHaveLength(1);
      expect(w.lastDelivered()[0].answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a stopped turn that a wake-up then carried on as ended, and keeps the reply past a stray error", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, state } = await started();
      say("Build started.");
      state("waiting");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "result", content: "", interrupted: true });
      state("working");
      say("Build passed.");
      endTurn(w);
      state("idle");
      // The CLI dies afterwards with an error of its own.
      session(w).emit("event", { kind: "error", content: "[Claude error] exited" });
      await settle();
      expect(told()).toEqual([
        note("its turn failed: [Claude error] exited", "do it", "Build passed."),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the lead's own stop alone, and a worker the user took over to the user", async () => {
    vi.useFakeTimers();
    try {
      const { lead, w, call, say, told, settle, session, endTurn, ask } = await started();
      session(w).isRunning = false;
      await call(lead, "stop_session", { session_id: w.id });
      await settle();
      expect(told()).toEqual([]);

      // The user's turns after the lead's message make it theirs.
      await ask("which commit?");
      say("abc123");
      await w.sendMessage("now rebase it");
      endTurn(w);
      await vi.advanceTimersByTimeAsync(0);
      say("Rebased.");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0].answered).toBe(true);

      // A failed turn too: the user is there to see it.
      await ask("and push it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await w.sendMessage("what happened?");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      expect(w.lastDelivered()[0]).toMatchObject({ since: true, answered: true });

      // A command the panel answers itself runs no turn.
      await ask("which branch?");
      say("main");
      endTurn(w);
      await w.sendMessage("/usage");
      await settle();
      expect(told()).toEqual([note("its turn ended", "which branch?", "main")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while anything is still to run: a queued message, a pause, a background task, a wake-up", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, ask, state } = await started();
      await ask("also this");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);

      const [agentId] = w.agents.keys();
      w.pauseAgent(agentId, Date.now() + 60_000);
      say("Also done.");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
      w.pauseAgent(agentId, 0);

      state("waiting");
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);

      state("sleeping");
      await settle();
      expect(told()).toEqual([]);
      state("idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "also this", "Also done.")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps two agents of a worker apart, and a stop of one from the other", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext } = await started();
      await askNext("is staging up?");
      const b = w.addAgent("B", "claude-opus-5-5", "b", "c", { backend: "claude" });
      const other = w.agents.get(b.id)!.session as FakeSession;
      await w.sendMessage("look at the logs", b.id);
      say("Need the staging URL.");
      endTurn(w);
      other.emit("event", { kind: "text_delta", content: "tailing them" });
      other.emit("runState", "waiting");
      other.isRunning = false;
      other.emit("event", { kind: "result", content: "" });
      w.abortAll();
      other.emit("runState", "idle");
      await settle();
      expect(told()).toEqual([note("its turn ended", "is staging up?", "Need the staging URL.")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws out of its timer, and stops with the manager", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { lead, w, told, settle, endTurn, ask, askNext, manager, host } = await started();
      await askNext("which branch?");
      const [leadAgent] = lead.agents.keys();
      lead.removeAgent(leadAgent);
      endTurn(w);
      await settle();
      expect(errors).toHaveBeenCalledWith("[projects]", expect.any(Error));

      host.addAgent(lead, "Lead", "claude-opus-5-5", "l", "c");
      await ask("again");
      manager.close();
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });

  it("comes from the panel, about the worker", async () => {
    vi.useFakeTimers();
    try {
      const { lead, w, endTurn, askNext, settle } = await started();
      await askNext("which branch?");
      endTurn(w);
      await settle();
      expect(lead.getMessages().find((m) => m.from?.workspaceId === w.id)!.from).toEqual({
        workspaceId: w.id,
        name: "w",
        role: "panel",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on a turn a restart cut off, a shutdown or a crash, without the lead", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, ask, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      let back = restart(w);
      expect(awaitsUser(back)).toBe(false);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(session(back).sent).toEqual([CARRY_ON]);
      expect(back.getMessages().filter((m) => m.from?.role === "panel")).toMatchObject([
        { from: { workspaceId: w.id, name: "w", role: "panel" } },
      ]);
      // What comes of it stands for the task: a question waits for the user.
      say("Which branch should this go on?", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([]);
      expect(awaitsUser(back)).toBe(true);
      // Nothing is cut off any more: a later restart carries nothing on.
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([]);
      expect(awaitsUser(back)).toBe(true);

      // The lead's later question, cut off by a crash mid-turn, goes on too,
      // and its answer reaches the lead as the answer to the question.
      await ask("which commit?");
      say("Looking", back);
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("abc123", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which commit?", "abc123")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on the lead's message past a command the user had the panel answer", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, askNext, session, endTurn } = await started();
      await askNext("which commit?");
      say("Looking");
      await w.sendMessage("/usage");
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("abc123", back);
      endTurn(back);
      await settle();
      expect(told()).toEqual([note("its turn ended", "which commit?", "abc123")]);
      expect(awaitsUser(back)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on once: cut off again, the lead is told", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, session } = await started();
      say("Halfway through");
      w.abortAll("restart");
      let back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([CARRY_ON]);
      say("Three quarters", back);
      back.abortAll("restart");
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual([]);
      expect(told()).toEqual([
        note("a server restart cut it off again after it carried on", "do it", "Three quarters"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a carry-on waiting for its start slot when the user writes first", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, restart, manager, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      const back = restart(w);
      manager.recheckWorkers();
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1000);
      // Other starts hold the next slots.
      manager.takeStartSlot(1000);
      manager.takeStartSlot(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session(back).sent).toEqual([]);
      await back.sendMessage("forget that, do this instead");
      endTurn(back);
      await vi.advanceTimersByTimeAsync(3 * START_SPACING_MS);
      expect(session(back).sent).toEqual(["forget that, do this instead"]);
      expect(told()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a turn a restart cut off to the user who wrote to it since", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, restart, manager, session, endTurn } = await started();
      say("Halfway through");
      w.abortAll("restart");
      const back = restart(w);
      await back.sendMessage("never mind, stop there");
      endTurn(back);
      manager.recheckWorkers();
      await settle();
      expect(session(back).sent).toEqual(["never mind, stop there"]);
      expect(told()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps across a restart what it owes and what it already reported", async () => {
    vi.useFakeTimers();
    try {
      const { w, call, say, told, settle, endTurn, restart, manager, ask } = await started();
      say("Done.");
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      let back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual(["Finished:\n\nmerged"]);

      // A notice still waiting at the restart.
      await ask("which commit?");
      say("abc123", back);
      endTurn(back);
      back = restart(back);
      manager.recheckWorkers();
      await settle();
      expect(told()[1]).toBe(note("its turn ended", "which commit?", "abc123"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a rate-limit retry still to run, however late it is", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, askNext } = await started();
      await askNext("is it merged?");
      const [agentId] = w.agents.keys();
      say("Working");
      w.pauseAgent(agentId, Date.now() + 1000, true);
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "rate limited" });
      await settle();
      expect(told()).toEqual([]);
      w.retryLast(agentId);
      say("Done now");
      endTurn(w);
      await settle();
      expect(told()).toEqual([note("its turn ended", "is it merged?", "Done now")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owes nothing once archived", async () => {
    vi.useFakeTimers();
    try {
      const { lead, w, told, settle, endTurn, call, manager } = await started();
      endTurn(w);
      await call(lead, "archive_session", { session_id: w.id });
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(w.getState().agents[0].delivered?.answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on a task whose background work a crash cut off, and shows no wait till then", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, state, restart, manager, session } = await started();
      say("Started the build in the background.");
      state("waiting");
      endTurn(w);
      const back = restart(w);
      expect(awaitsUser(back)).toBe(false);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(session(back).sent).toEqual([CARRY_ON]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the lead what a session the user started answers it", async () => {
    vi.useFakeTimers();
    try {
      const { lead, call, host, project, session, endTurn, settle, w } = await started();
      const own = host.createWorkspace("mine", w.cwd, { projectId: project.id, role: "worker" });
      host.addAgent(own, "A", "claude-opus-5-5", "a", "c");
      await own.sendMessage("what does this do?");
      endTurn(own);
      await settle();
      await call(lead, "message_session", { session_id: own.id, message: "which branch?" });
      await vi.advanceTimersByTimeAsync(0);
      session(own).emit("event", { kind: "text_delta", content: "main" });
      endTurn(own);
      await settle();
      expect(
        lead
          .getMessages()
          .filter((m) => m.from?.workspaceId === own.id)
          .map((m) => m.content),
      ).toEqual([note("its turn ended", "which branch?", "main")]);
      expect(awaitsUser(own)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a fresh lead nothing of what the lead of a deleted project said", async () => {
    vi.useFakeTimers();
    try {
      const { w, endTurn, settle, manager, project, workspaces } = await started();
      manager.delete(project.id);
      endTurn(w);
      manager.adopt(w);
      manager.recheckWorkers();
      await settle();
      const fresh = workspaces.get(manager.get(w.projectLink!.projectId)!.leadWorkspaceId!)!;
      expect(fresh.getMessages().filter((m) => m.from)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows it waiting for the user when its task or the user's turn ends on them", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, settle, endTurn, restart, frames } = await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      say("Which branch should this go on?");
      endTurn(w);
      // At once, and once.
      expect(shown()).toEqual([true]);
      await settle();
      expect(shown()).toEqual([true]);
      expect(awaitsUser(restart(w))).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const { w, say, settle, endTurn, session, call, askNext, frames, manager, project } =
        await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      say("Which branch?");
      endTurn(w);
      // The user answers, and it reports the task finished. A client that
      // connects meanwhile leaves the others holding what it gets.
      await w.sendMessage("main");
      expect(awaitsUser(w)).toBe(false);
      manager.showAllAwaiting();
      expect(shown()).toEqual([true, false]);
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      // A command the panel answers itself is no turn, during one or after.
      await w.sendMessage("/usage");
      endTurn(w);
      await settle();
      await w.sendMessage("/usage");
      manager.showAllAwaiting();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false]);

      // A question of the user's after that is answered to them; not inside
      // an archived project.
      await w.sendMessage("which commit?");
      say("abc123");
      endTurn(w);
      await settle();
      expect(shown()).toEqual([true, false, true]);
      manager.setArchived(project.id, true);
      manager.setArchived(project.id, false);
      expect(shown()).toEqual([true, false, true, false, true]);

      // What it answers the lead later is the lead's.
      await w.sendMessage("thanks");
      await askNext("is it pushed?");
      say("yes");
      endTurn(w);
      await settle();
      expect(shown()).toEqual([true, false, true, false, true, false]);

      // A failed turn, or one the user stopped, asks nothing.
      await w.sendMessage("push the tag");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(awaitsUser(w)).toBe(false);
      await w.sendMessage("try again");
      say("Pushing");
      session(w).isRunning = false;
      w.abortAll();
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false, true, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows it waiting only once nothing more is to run, through wake-ups and notices", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, settle, endTurn, state, call, session, frames } = await started();
      const shown = () =>
        frames
          .filter((f) => f.type === "workspace_updated" && f.id === w.id)
          .map((f) => f.awaitsUser === true);
      // A background task still runs, then a pause holds it: not yet.
      say("Which branch? The build runs meanwhile.");
      state("waiting");
      endTurn(w);
      expect(awaitsUser(w)).toBe(false);
      const [agentId] = w.agents.keys();
      w.pauseAgent(agentId, Date.now() + 1000);
      state("idle");
      expect(shown()).toEqual([]);
      await settle();
      expect(shown()).toEqual([true]);
      // A notice of the panel's after it changes nothing.
      w.postSystemMessage("Context compacted.");
      expect(awaitsUser(w)).toBe(true);
      // Reported finished, a wake-up's turn after it asks nothing.
      await w.sendMessage("main");
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      session(w).isRunning = true;
      say("late output");
      endTurn(w);
      await settle();
      expect(awaitsUser(w)).toBe(false);
      expect(shown()).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a task the lead retried after it failed waiting for the user", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, session, endTurn, ask } = await started();
      say("Working on it");
      session(w).isRunning = false;
      session(w).emit("event", { kind: "error", content: "API Error: 529 overloaded" });
      await settle();
      expect(told()).toHaveLength(1);
      await ask("try again");
      say("Which branch should this go on?");
      endTurn(w);
      await settle();
      expect(told()).toHaveLength(1);
      expect(awaitsUser(w)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no command the panel answered as the user's turn after a restart", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, settle, session, call, endTurn, restart } = await started();
      say("Which branch?");
      endTurn(w);
      await w.sendMessage("main");
      session(w).emit("event", {
        kind: "tool_use",
        toolName: "mcp__panel__finish_task",
        toolUseId: "t1",
        content: "**finish_task**",
      });
      await call(w, "finish_task", { summary: "merged" });
      endTurn(w);
      await w.sendMessage("/usage");
      await settle();
      expect(awaitsUser(restart(w))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves to the user across a restart what they took over", async () => {
    vi.useFakeTimers();
    try {
      const { w, say, told, settle, endTurn, askNext, restart, manager } = await started();
      await askNext("which commit?");
      say("abc123");
      endTurn(w);
      await w.sendMessage("thanks");
      endTurn(w);
      const back = restart(w);
      manager.recheckWorkers();
      await settle();
      expect(told()).toEqual([]);
      expect(back.lastDelivered()[0]).toMatchObject({ since: true, answered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never shows the lead, a session the user started or an archived one waiting", async () => {
    vi.useFakeTimers();
    try {
      const { lead, w, say, endTurn, call, host, session, project } = await started();
      say("Which branch?");
      endTurn(w);
      expect(awaitsUser(w)).toBe(true);
      await call(lead, "archive_session", { session_id: w.id });
      expect(awaitsUser(w)).toBe(false);

      const own = host.createWorkspace("mine", w.cwd, { projectId: project.id, role: "worker" });
      host.addAgent(own, "A", "claude-opus-5-5", "a", "c");
      await own.sendMessage("what does this do?");
      session(own).emit("event", { kind: "text_delta", content: "It parses." });
      endTurn(own);
      expect(awaitsUser(own)).toBe(false);

      await lead.sendMessage("hi");
      session(lead).emit("event", { kind: "text_delta", content: "Hello." });
      endTurn(lead);
      expect(awaitsUser(lead)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet for an archived project", async () => {
    vi.useFakeTimers();
    try {
      const { w, told, settle, endTurn, askNext, manager, project } = await started();
      await askNext("which branch?");
      manager.setArchived(project.id, true);
      endTurn(w);
      await settle();
      expect(told()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
