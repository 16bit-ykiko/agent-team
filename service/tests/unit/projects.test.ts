import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ProjectStore } from "../../src/project/store";
import { leadToolset, workerToolset, type PanelApi } from "../../src/project/tools";
import { START_SPACING_MS } from "../../src/project/manager";
import { Workspace } from "../../src/workspace/workspace";
import { saveIndex, saveWorkspace, loadAll } from "../../src/workspace/state";
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
    readSession: record("readSession"),
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
      ["readSession", "p1", "ws-w", 6],
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
    await t.finish_task.handler({ summary: "merged" });
    await t.finish_task.handler({ summary: "which API?", blocked: true });
    expect(calls).toEqual([
      ["workerReport", "ws-w", "tests pass", false],
      ["workerReport", "ws-w", "merged", true, false],
      ["workerReport", "ws-w", "which API?", true, true],
    ]);
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
    expect([...lead.agents.values()][0].info.model).toBe("claude-opus-5-5[1m]");
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
    ws.pauseAgent(agent.id, Date.now() + 3600_000);

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
      "on claude-opus-5-5[1m]",
    );
    expect([...workers()[0].agents.values()][0].info.model).toBe("claude-opus-5-5[1m]");
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
    expect(headers[1]).toMatch(/ · done · 1 tool calls$/);
    expect(out).toContain("x".repeat(3000) + " …(truncated)");
    const last1 = await call(lead, "read_session", { session_id: worker.id, last: 1 });
    expect(last1.split("\n").filter((l) => l.startsWith("--- "))).toHaveLength(1);
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
