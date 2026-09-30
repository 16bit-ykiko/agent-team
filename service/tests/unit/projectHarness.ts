// A ProjectManager over real Workspaces whose sessions are fakes: tools are
// called the way the CLI would, through the toolset the session was given.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach } from "vitest";
import { ProjectManager, type ProjectHost } from "../../src/project/manager";
import type { Objective } from "../../src/project/objectives";
import { Workspace, type Message, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { HostRegistry } from "../../src/session/host";
import { HistoryService } from "../../src/workspace/history-service";
import { closeHistory, historyFile, historyIndexFile, historyOf } from "../../src/workspace/state";
import { FakeHost, FakeSession } from "./fakes";

const dirs: string[] = [];
const managers: ProjectManager[] = [];
const closers: Array<() => Promise<void> | void> = [];
export function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-projects-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const m of managers.splice(0)) m.close();
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

export const tick = () => new Promise((r) => setTimeout(r, 5));

export function setupProjects() {
  const base = tmpDir();
  const root = path.join(base, "repo");
  fs.mkdirSync(path.join(root, "wt"), { recursive: true });
  const registry = new HostRegistry();
  registry.register(new FakeHost());
  const workspaces = new Map<string, Workspace>();
  const frames: Array<Record<string, unknown>> = [];
  const history = new HistoryService(historyIndexFile(base), historyFile(base));
  closers.push(
    () => history.close(),
    () => closeHistory(base),
  );
  // Saves a workspace's history where the host finds it, and unloads it.
  const store = (w: Workspace, messages: Message[]) => {
    historyOf(base).save(w.id, messages, "all");
    history.changed();
    w.unloadMessages();
  };
  // What the server saves as it goes: every loaded history.
  const saveAll = () => {
    for (const w of workspaces.values()) {
      if (w.messagesLoaded) historyOf(base).save(w.id, w.getMessages(), "all");
    }
    history.changed();
  };
  const saved: string[] = [];
  const cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    onAgentIdle: (wsId) => manager.workerIdle(workspaces.get(wsId)!),
    onAgentState: (wsId, _agentId, state) => {
      if (state === "idle") manager.workerIdle(workspaces.get(wsId)!);
    },
  };
  let n = 0;
  const host: ProjectHost = {
    workspaces: () => workspaces.values(),
    workspace: (id) => workspaces.get(id),
    createWorkspace: (name, cwd, link) => {
      const w = new Workspace(`ws-${++n}`, name, "repo", "local", cwd, registry, cb);
      w.projectLink = link;
      workspaces.set(w.id, w);
      return w;
    },
    addAgent: (w, name, model, avatar, color) => {
      const agent = w.addAgent(name, model, avatar, color, { backend: "claude" });
      w.agents.get(agent.id)!.session.setPanelTools?.(manager.toolsFor(w));
    },
    removeWorkspace: (id) => {
      workspaces.get(id)?.dispose();
      workspaces.delete(id);
    },
    archiveWorkspace: (w) => {
      if (!w.isIdle) return false;
      w.archivedAt = Date.now();
      return true;
    },
    restoreWorkspace: (w) => {
      w.archivedAt = null;
      return true;
    },
    loadWorkspace: (w) => {
      if (!w.messagesLoaded) w.setMessages(historyOf(base).load(w.id));
      return true;
    },
    history,
    persistWorkspace: () => {},
    saveWorkspaceNow: (w) => void saved.push(w.id),
    workspaceChanged: (w) => void frames.push({ type: "workspace_updated", id: w.id }),
    broadcast: (m) => void frames.push(m as Record<string, unknown>),
  };
  const manager = new ProjectManager(base, host);
  managers.push(manager);
  const session = (w: Workspace) => [...w.agents.values()][0].session as FakeSession;
  const call = (w: Workspace, tool: string, args: Record<string, unknown> = {}) =>
    session(w)
      .panelTools!.tools.find((x) => x.name === tool)!
      .handler(args);
  // The first project in the repository; one folder per project, so any
  // other gets a repository of its own beside it.
  const create = (name: string) => {
    const taken = manager.list().some((p) => p.root === root);
    const at = taken ? path.join(base, `repo-${name}`) : root;
    fs.mkdirSync(path.join(at, "wt"), { recursive: true });
    const p = manager.create(name, at);
    return { project: p, lead: workspaces.get(p.leadWorkspaceId!)! };
  };
  const workers = () => [...workspaces.values()].filter((w) => w.projectLink?.role === "worker");
  // The first project's readable objectives.
  const objectives = () =>
    manager.list()[0].objectives.filter((o): o is Objective => !("error" in o));
  // The turn in progress ends.
  const endTurn = (w: Workspace) => {
    session(w).isRunning = false;
    session(w).emit("event", { kind: "result", content: "" });
  };
  return {
    base,
    root,
    registry,
    host,
    store,
    saveAll,
    manager,
    workspaces,
    frames,
    saved,
    session,
    call,
    create,
    workers,
    objectives,
    endTurn,
  };
}

// An objective core/modules with one task t1, made through the lead's tools.
export async function withTask(
  call: (w: Workspace, tool: string, args?: Record<string, unknown>) => Promise<string>,
  lead: Workspace,
): Promise<void> {
  await call(lead, "write_objective", { id: "core/modules", title: "Modules", goal: "C++20" });
  await call(lead, "add_items", { objective_id: "core/modules", tasks: ["implement"] });
}
