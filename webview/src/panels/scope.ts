import type { Objective, ObjectiveTask, Project, Workspace } from "../state/useServer";
import { agentState } from "../workspace/agents";
import type { FileRoot } from "./FilesPanel";

// What the side panels cover: every session of the active workspace's
// project (lead first, then the most recently active), or the workspace on
// its own.
export function scopeSessions(
  active: Workspace | undefined,
  workspaces: Workspace[],
  project: Project | undefined,
): Workspace[] {
  if (!active) return [];
  if (!project) return [active];
  const last = (w: Workspace) => w.lastMessageAt ?? w.createdAt;
  return workspaces
    .filter((w) => w.projectLink?.projectId === project.id)
    .sort(
      (a, b) =>
        Number(b.projectLink?.role === "lead") - Number(a.projectLink?.role === "lead") ||
        last(b) - last(a),
    );
}

export type SessionState = "working" | "waiting" | "sleeping" | "idle" | "archived";

// The busiest state among a session's agents.
export function sessionState(w: Workspace): SessionState {
  if (w.archivedAt != null) return "archived";
  const states = w.agents.map(agentState);
  for (const s of ["working", "waiting", "sleeping"] as const) if (states.includes(s)) return s;
  return "idle";
}

// What a session is doing on the board: the objectives it is linked to, and
// the task it carries out in each, if any.
export function sessionWork(
  sessionId: string,
  objectives: Array<Objective | { id: string; error: string }>,
): Array<{ objective: Objective; task?: ObjectiveTask }> {
  const out: Array<{ objective: Objective; task?: ObjectiveTask }> = [];
  for (const o of objectives) {
    if ("error" in o || o.archived) continue;
    const task = o.tasks.find((t) => t.session === sessionId && t.state !== "done");
    if (task || o.sessions.includes(sessionId)) out.push({ objective: o, ...(task && { task }) });
  }
  return out;
}

// "2 working · 1 waiting", or "idle": the counts of sessions (or agents, for
// a single workspace) by state, busiest first.
export function stateSummary(states: SessionState[]): string {
  const order: SessionState[] = ["working", "waiting", "sleeping"];
  const parts = order
    .map((s) => [s, states.filter((x) => x === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return parts.length ? parts.join(" · ") : "idle";
}

// Under a panel's title: whose sessions, how many, and what they do; for a
// workspace on its own, what its agents do.
export function scopeSummary(sessions: Workspace[], project: Project | undefined): string {
  if (!project) {
    const w = sessions[0];
    if (!w) return "";
    if (w.archivedAt != null) return `${w.name} · archived`;
    const n = w.agents.length;
    return `${w.name} · ${n} agent${n === 1 ? "" : "s"} · ${stateSummary(w.agents.map(agentState))}`;
  }
  const live = sessions.filter((w) => w.archivedAt == null);
  const count = `${live.length} session${live.length === 1 ? "" : "s"}`;
  return `${project.name} · ${count} · ${stateSummary(live.map(sessionState))}`;
}

// The branch a project usually sits on: not worth a word on every row.
export const DEFAULT_BRANCH = /^(main|master)$/;

// Within its project a session goes by what follows the project's name
// ("clice · lead" is the lead).
export function sessionName(w: Workspace, project: Project | undefined): string {
  const prefix = project ? `${project.name} · ` : null;
  return prefix && w.name.startsWith(prefix) && w.name.length > prefix.length
    ? w.name.slice(prefix.length)
    : w.name;
}

// The folders the Files panel offers: each live session's working directory
// (a project's repository and its worktrees), once each.
export function fileRoots(sessions: Workspace[]): FileRoot[] {
  const seen = new Set<string>();
  const out: FileRoot[] = [];
  for (const w of sessions) {
    if (w.archivedAt != null || seen.has(w.cwd)) continue;
    seen.add(w.cwd);
    const name = w.cwd.split("/").filter(Boolean).pop() ?? w.cwd;
    out.push({ label: w.git?.branch ? `${name} · ${w.git.branch}` : name, path: w.cwd });
  }
  return out;
}
