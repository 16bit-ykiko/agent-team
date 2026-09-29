import type { Project, Workspace } from "../state/useServer";
import { isAgentActive } from "../workspace/agents";

// Groups older than this default to collapsed in the sidebar.
export const STALE_MS = 3 * 86_400_000;

export interface WorkspaceGroup {
  // Group key = the workspace cwd, so same-folder workspaces fold together;
  // a project's workspaces fold under "project:<id>" wherever they work.
  key: string;
  label: string;
  project?: Project;
  workspaces: Workspace[];
  lastActive: number;
  running: boolean;
}

function lastActive(ws: Workspace): number {
  return ws.lastMessageAt ?? ws.createdAt;
}

export function isArchived(ws: Workspace): boolean {
  return ws.archivedAt != null;
}

// Archived workspaces live in their own flat section, newest first.
export function archivedWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter(isArchived).sort((a, b) => lastActive(b) - lastActive(a));
}

// Two-level sidebar: live workspaces grouped by folder, groups sorted by most
// recent activity, workspaces within a group likewise. Projects come first,
// each with its lead on top of the sessions it started.
export function groupWorkspaces(
  workspaces: Workspace[],
  projects: Project[] = [],
): WorkspaceGroup[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byCwd = new Map<string, Workspace[]>();
  for (const ws of workspaces) {
    if (isArchived(ws)) continue;
    const project = ws.projectLink && byId.get(ws.projectLink.projectId);
    const key = project ? `project:${project.id}` : ws.cwd || "(no path)";
    const list = byCwd.get(key);
    if (list) list.push(ws);
    else byCwd.set(key, [ws]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [key, list] of byCwd) {
    const project = byId.get(key.slice("project:".length));
    const isLead = (w: Workspace) => (w.projectLink?.role === "lead" ? 1 : 0);
    list.sort((a, b) => isLead(b) - isLead(a) || lastActive(b) - lastActive(a));
    groups.push({
      key,
      label: project?.name ?? key.split("/").filter(Boolean).pop() ?? key,
      ...(project && { project }),
      workspaces: list,
      lastActive: Math.max(...list.map(lastActive)),
      running: list.some((w) => w.agents.some(isAgentActive)),
    });
  }
  groups.sort((a, b) => (b.project ? 1 : 0) - (a.project ? 1 : 0) || b.lastActive - a.lastActive);
  return groups;
}

// A group starts expanded when it has recent activity, something running, or
// holds the active workspace — but an explicit user toggle (persisted per
// group key) always wins, so even the active group can be collapsed.
export function isGroupExpanded(
  group: WorkspaceGroup,
  overrides: Record<string, boolean>,
  now: number,
  containsActive = false,
): boolean {
  const override = overrides[group.key];
  if (override !== undefined) return override;
  return containsActive || group.running || now - group.lastActive < STALE_MS;
}
