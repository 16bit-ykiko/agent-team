// A ProjectManager over real Workspaces whose sessions are fakes: tools are
// called the way the CLI would, through the toolset the session was given.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach } from "vitest";
import { ProjectManager, type ProjectHost } from "../../src/project/manager";
import type { Objective } from "../../src/project/objectives";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { HostRegistry } from "../../src/session/host";
import { FakeHost, FakeSession } from "./fakes";

const dirs: string[] = [];
const managers: ProjectManager[] = [];
export function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-projects-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
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
  const saved: string[] = [];
  const cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
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
    loadWorkspace: () => true,
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
  const create = (name: string) => {
    const p = manager.create(name, root);
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
