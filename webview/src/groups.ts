import { Workspace } from "./useServer";
import { hasRunningSubagents } from "./events";

// Groups older than this default to collapsed in the sidebar.
export const STALE_MS = 3 * 86_400_000;

export interface WorkspaceGroup {
  // Group key = the workspace cwd, so same-folder workspaces fold together.
  key: string;
  label: string;
  workspaces: Workspace[];
  lastActive: number;
  running: boolean;
}

function lastActive(ws: Workspace): number {
  return ws.lastMessageAt ?? ws.createdAt;
}

// Two-level sidebar: workspaces grouped by folder, groups sorted by most
// recent activity, workspaces within a group likewise.
export function groupWorkspaces(workspaces: Workspace[]): WorkspaceGroup[] {
  const byCwd = new Map<string, Workspace[]>();
  for (const ws of workspaces) {
    const key = ws.cwd || "(no path)";
    const list = byCwd.get(key);
    if (list) list.push(ws);
    else byCwd.set(key, [ws]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [key, list] of byCwd) {
    list.sort((a, b) => lastActive(b) - lastActive(a));
    groups.push({
      key,
      label: key.split("/").filter(Boolean).pop() ?? key,
      workspaces: list,
      lastActive: Math.max(...list.map(lastActive)),
      running: list.some(
        (w) =>
          w.agents.some((a) => a.busy) || w.messages.some((m) => hasRunningSubagents(m.events)),
      ),
    });
  }
  groups.sort((a, b) => b.lastActive - a.lastActive);
  return groups;
}

// A group starts expanded when it has recent activity or something running;
// an explicit user toggle (persisted per group key) always wins.
export function isGroupExpanded(
  group: WorkspaceGroup,
  overrides: Record<string, boolean>,
  now: number,
): boolean {
  const override = overrides[group.key];
  if (override !== undefined) return override;
  return group.running || now - group.lastActive < STALE_MS;
}
