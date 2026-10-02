import { memo, useState } from "react";
import type { Workspace, Project, SystemStatus, SearchHit } from "../state/useServer";
import {
  groupWorkspaces,
  isGroupExpanded,
  archivedWorkspaces,
  type WorkspaceGroup,
} from "./groups";
import { isAgentActive } from "../workspace/agents";
import { Icon } from "../panels/Icon";
import { formatBytes, formatRelative, formatResetTime } from "../format";

// The branch a project usually sits on: not worth a word on every row.
const DEFAULT_BRANCH = /^(main|master)$/;

function gitTitle(git: { dirty: number; ahead: number; behind: number }): string {
  const parts: string[] = [];
  if (git.dirty) parts.push(`${git.dirty} changed file${git.dirty === 1 ? "" : "s"}`);
  if (git.ahead) parts.push(`${git.ahead} ahead`);
  if (git.behind) parts.push(`${git.behind} behind`);
  return parts.length ? parts.join(", ") : "clean";
}

function quotaBarColor(pct: number): string {
  if (pct >= 80) return "var(--error)";
  if (pct >= 50) return "var(--warning)";
  return "var(--accent)";
}

function StatusBar({ label, pct, extra }: { label: string; pct: number; extra?: string }) {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className="status-value">
        <span className="status-bar">
          <span
            className="status-bar-fill"
            style={{ width: `${pct}%`, background: quotaBarColor(pct) }}
          />
        </span>
        <span className="status-pct">{extra ?? `${pct}%`}</span>
      </span>
    </div>
  );
}

export function SystemStatusPanel({
  status,
  accounts,
  defaultAccount,
  onSetDefault,
}: {
  status: SystemStatus;
  accounts: string[];
  defaultAccount: string | null;
  onSetDefault: (account: string | null) => void;
}) {
  const memPct = Math.round((status.memUsed / status.memTotal) * 100);

  return (
    <div className="system-status-panel">
      {accounts.length > 0 && (
        <div className="default-account-row" title="Account used by agents without an explicit one">
          <span>Account</span>
          <select
            value={defaultAccount ?? ""}
            onChange={(e) => onSetDefault(e.target.value || null)}
          >
            <option value="">local</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="system-status-grid">
        <StatusBar label="CPU" pct={status.cpuUsage} />
        <StatusBar
          label="Mem"
          pct={memPct}
          extra={`${formatBytes(status.memUsed)} / ${formatBytes(status.memTotal)}`}
        />
        {status.quota.flatMap((q) => {
          const tag = status.quota.length > 1 ? q.label : "Opus";
          const items = [];
          if (q.fiveHour) {
            const pct = Math.round(q.fiveHour.utilization * 100);
            items.push(
              <StatusBar
                key={`${q.label}-5h`}
                label={`${tag} 5h`}
                pct={pct}
                extra={`${pct}% · ${formatResetTime(q.fiveHour.resetsAt)}`}
              />,
            );
          }
          if (q.sevenDay) {
            const pct = Math.round(q.sevenDay.utilization * 100);
            items.push(
              <StatusBar
                key={`${q.label}-7d`}
                label={`${tag} 7d`}
                pct={pct}
                extra={`${pct}% · ${formatResetTime(q.sevenDay.resetsAt)}`}
              />,
            );
          }
          return items;
        })}
      </div>
    </div>
  );
}

export interface SidebarProps {
  workspaces: Workspace[];
  projects?: Project[];
  activeWsId: string | null;
  connected: boolean;
  groupOverrides: Record<string, boolean>;
  seenCounts: Record<string, number>;
  finishedStatus: Record<string, "done" | "failed">;
  searchQuery: string;
  searchHits: SearchHit[] | null;
  systemStatus: SystemStatus | null;
  accounts: string[];
  defaultAccount: string | null;
  now?: number;
  onSelect: (wsId: string) => void;
  onDelete: (wsId: string) => void;
  // The × on a project's lead deletes the project (after confirming).
  onDeleteProject?: (projectId: string) => void;
  onToggleGroup: (key: string, expanded: boolean) => void;
  onSearchChange: (q: string) => void;
  onJump: (wsId: string, msgId: string) => void;
  onCreate: () => void;
  // Create a workspace in a group's folder (the "+" on the group header).
  onCreateIn: (cwd: string) => void;
  onReplayDemo: () => void;
  // Save a layout snapshot on the server (see debugSnapshot.ts).
  onDebugSnapshot: () => void;
  // One project's archived sessions, or (null) those in no project.
  onPurgeArchived: (projectId: string | null) => void;
  onRestoreProject?: (projectId: string) => void;
  onSetDefaultAccount: (account: string | null) => void;
}

export const Sidebar = memo(function Sidebar(p: SidebarProps) {
  const now = p.now ?? Date.now();
  const known = new Set((p.projects ?? []).map((pr) => pr.id));
  // A lead takes its project with it; one whose project is unknown (its
  // project.json unreadable) is just a workspace.
  const deleteButton = (ws: Workspace) => {
    const link = ws.projectLink;
    const project = link?.role === "lead" && known.has(link.projectId) ? link.projectId : null;
    return (
      <button
        className="task-delete"
        title={project ? "Delete project" : "Delete"}
        onClick={(e) => {
          e.stopPropagation();
          if (project && p.onDeleteProject) p.onDeleteProject(project);
          else p.onDelete(ws.id);
        }}
      >
        <Icon name="close" />
      </button>
    );
  };
  const groups = groupWorkspaces(p.workspaces, p.projects);
  const archived = archivedWorkspaces(p.workspaces, p.projects);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeIsArchived = archived.some((w) => w.id === p.activeWsId);
  const showArchived = archivedOpen || activeIsArchived;
  const live = groups.filter((g) => !g.project?.archivedAt);
  const shelved = groups.filter((g) => g.project?.archivedAt);
  const [shelfOpen, setShelfOpen] = useState(false);
  const showShelf =
    shelfOpen ||
    shelved.some((g) => [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId));
  // Groups whose archived sessions are unfolded.
  const [openArchives, setOpenArchives] = useState<ReadonlySet<string>>(new Set());
  const toggleArchive = (key: string) =>
    setOpenArchives((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const archivedItem = (ws: Workspace, folder: string | null) => (
    <div
      key={ws.id}
      className={`task-item task-item-archived ${ws.id === p.activeWsId ? "active" : ""}`}
      onClick={() => p.onSelect(ws.id)}
      title={ws.cwd}
    >
      <div className="task-status idle" />
      <div className="task-info">
        <div className="task-name">
          <span className="task-name-text">
            <span className="clip">{ws.name}</span>
          </span>
          <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        </div>
        {folder && <div className="task-meta">{folder}</div>}
      </div>
      <span className="task-hover">
        <span className="task-time">{formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}</span>
        {deleteButton(ws)}
      </span>
    </div>
  );

  // A group's archived sessions, folded until asked for (or one is open).
  const archiveList = (g: WorkspaceGroup) => {
    const open = openArchives.has(g.key) || g.archived.some((w) => w.id === p.activeWsId);
    const root = g.project?.root;
    return (
      <>
        <div
          className="ws-archive-toggle"
          role="button"
          aria-expanded={open}
          onClick={() => toggleArchive(g.key)}
        >
          <span className="events-toggle">{open ? "▾" : "▸"}</span>
          <span>Archived</span>
          {open && <span className="ws-group-count">{g.archived.length}</span>}
          {open && g.project && (
            <button
              className="ws-archived-purge"
              title={`Delete the archived sessions of ${g.label}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onPurgeArchived(g.project!.id);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {open &&
          g.archived.map((w) =>
            archivedItem(
              w,
              w.cwd === root ? null : (w.cwd.split("/").filter(Boolean).pop() ?? w.cwd),
            ),
          )}
      </>
    );
  };

  // A folder's group or a project's (its row is its lead), with its archived
  // sessions folded under it; `shelf` for an archived project's.
  const renderGroup = (g: WorkspaceGroup, shelf = false) => {
    const expanded = isGroupExpanded(
      g,
      p.groupOverrides,
      now,
      [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId),
    );
    const toggle = () => p.onToggleGroup(g.key, !expanded);
    // A project's own row is its lead: it opens the lead, which is not
    // listed again under it; the arrow folds the sessions it started.
    const lead = g.project ? g.workspaces.find((w) => w.projectLink?.role === "lead") : undefined;
    const items = lead ? g.workspaces.filter((w) => w !== lead) : g.workspaces;
    const leadUnread = lead ? lead.messages.length - (p.seenCounts[lead.id] ?? 0) : 0;
    const hasContent = items.length > 0 || g.archived.length > 0;
    // A project of archived sessions only (its lead archived too) has no live one.
    const git = (g.workspaces[0] ?? g.archived[0])?.git;
    // The group of the open session: on touch only its row offers a new one.
    const current = [...g.workspaces, ...g.archived].some((w) => w.id === p.activeWsId);
    return (
      <div key={g.key} className="ws-group">
        <div
          className={`ws-group-header${g.project ? " ws-group-project" : ""}${lead && lead.id === p.activeWsId ? " active" : ""}${current ? " current" : ""}`}
          title={lead ? `Open the lead of ${g.label}` : (g.project?.root ?? g.key)}
          onClick={() => (lead ? p.onSelect(lead.id) : toggle())}
        >
          {lead && !hasContent ? (
            // Nothing to fold: an empty slot keeps the name in line.
            <span className="events-toggle" />
          ) : lead ? (
            <button
              className="events-toggle ws-group-toggle"
              aria-label={expanded ? `Fold ${g.label}` : `Unfold ${g.label}`}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="events-toggle">{expanded ? "▾" : "▸"}</span>
          )}
          <span className="ws-group-label">{g.label}</span>
          {leadUnread > 0 && lead!.id !== p.activeWsId && (
            <span className="unread-badge">{leadUnread}</span>
          )}
          {git?.branch && (!DEFAULT_BRANCH.test(git.branch) || git.dirty > 0) && (
            <span className="ws-group-branch" title={gitTitle(git)}>
              {!DEFAULT_BRANCH.test(git.branch) && git.branch}
              {git.dirty > 0 && <span className="ws-group-dirty">●</span>}
            </span>
          )}
          <button
            className="ws-group-add"
            title={g.project ? `New session in ${g.project.name}` : `New workspace in ${g.key}`}
            onClick={(e) => {
              e.stopPropagation();
              p.onCreateIn(g.project?.root ?? g.key);
            }}
          >
            <Icon name="plus" />
          </button>
          {!expanded && items.length > 0 && <span className="ws-group-count">{items.length}</span>}
          {g.running && <span className="streaming-dot" />}
          {shelf && g.project && p.onRestoreProject && (
            <button
              className="ws-group-restore"
              title={`Bring ${g.label} back among the projects`}
              onClick={(e) => {
                e.stopPropagation();
                p.onRestoreProject!(g.project!.id);
              }}
            >
              Restore
            </button>
          )}
          {lead && deleteButton(lead)}
        </div>
        {expanded && hasContent && (
          <div className="ws-group-items">
            {items.map((ws) => {
              const running = ws.agents.some(isAgentActive);
              const unread = ws.messages.length - (p.seenCounts[ws.id] ?? 0);
              const awaits = ws.awaitsUser && !running && ws.id !== p.activeWsId;
              return (
                <div
                  key={ws.id}
                  className={`task-item ${ws.id === p.activeWsId ? "active" : ""}${running ? " task-item-active" : ""}`}
                  onClick={() => p.onSelect(ws.id)}
                >
                  <div
                    className={`task-status ${running ? "running" : (p.finishedStatus[ws.id] ?? "idle")}`}
                  />
                  <div className="task-info">
                    <div className="task-name">
                      <span className="task-name-text">
                        {ws.projectLink?.role === "lead" && (
                          <span className="task-lead-tag">lead</span>
                        )}
                        <span className="clip" title={ws.name}>
                          {ws.name}
                        </span>
                        {awaits && (
                          <span className="awaits-tag" title="Waiting for your reply">
                            your turn
                          </span>
                        )}
                        {unread > 0 && ws.id !== p.activeWsId && (
                          <span className="unread-badge">{unread}</span>
                        )}
                      </span>
                    </div>
                  </div>
                  <span className="task-hover">
                    <span className="task-time">
                      {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
                    </span>
                    {deleteButton(ws)}
                  </span>
                </div>
              );
            })}
            {g.archived.length > 0 && archiveList(g)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-header">
        <span className="sidebar-title">
          Workspaces {!p.connected && <span className="disconnected">offline</span>}
        </span>
        <span className="sidebar-actions">
          <button
            title="Replay rendering demo (synthetic events for visual review)"
            onClick={p.onReplayDemo}
          >
            <Icon name="play" />
          </button>
          <button title="New workspace" onClick={p.onCreate}>
            <Icon name="plus" />
          </button>
          <button
            className="sidebar-debug"
            title="Save a layout debug snapshot (viewport, geometry, DOM) on the server"
            onClick={p.onDebugSnapshot}
          >
            <Icon name="snapshot" />
          </button>
        </span>
      </div>
      <div className="search-bar">
        <input
          type="text"
          value={p.searchQuery}
          onChange={(e) => p.onSearchChange(e.target.value)}
          placeholder="Search messages…"
          autoComplete="off"
        />
        {p.searchQuery && (
          <button className="search-clear" onClick={() => p.onSearchChange("")}>
            ×
          </button>
        )}
      </div>
      {p.searchQuery.trim() ? (
        <div className="search-results">
          {p.searchHits === null ? (
            <div className="search-empty">Searching…</div>
          ) : p.searchHits.length === 0 ? (
            <div className="search-empty">No results</div>
          ) : (
            p.searchHits.map((r, i) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => p.onJump(r.workspaceId, r.messageId)}
              >
                <div className="search-result-ws">{r.workspaceName}</div>
                <div className="search-result-snippet">{r.snippet}</div>
                <div className="search-result-time">
                  {new Date(r.timestamp).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="task-list">
          {groups.length === 0 && archived.length === 0 && (
            <div className="sidebar-empty">No workspaces yet</div>
          )}
          {live.map((g) => renderGroup(g))}
          {shelved.length > 0 && (
            <div className="ws-group ws-shelf">
              <div
                className="ws-group-header ws-archived-header"
                onClick={() => setShelfOpen((v) => !v)}
                title="Projects filed away. Their leads and history are still there."
              >
                <span className="events-toggle">{showShelf ? "▾" : "▸"}</span>
                <span className="ws-group-label">Archived projects</span>
                <span className="ws-group-count">{shelved.length}</span>
              </div>
              {showShelf && shelved.map((g) => renderGroup(g, true))}
            </div>
          )}
          {archived.length > 0 && (
            <div className="ws-group ws-archived">
              <div
                className="ws-group-header ws-archived-header"
                onClick={() => setArchivedOpen((v) => !v)}
                title="Idle workspaces. History stays on disk; sending a message restores one."
              >
                <span className="events-toggle">{showArchived ? "▾" : "▸"}</span>
                <span className="ws-group-label">Archived</span>
                {showArchived && <span className="ws-group-count">{archived.length}</span>}
                {showArchived && (
                  <button
                    className="ws-archived-purge"
                    title="Delete the archived workspaces that belong to no project"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPurgeArchived(null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {showArchived && (
                <div className="ws-group-items">
                  {archived.map((ws) => archivedItem(ws, ws.project))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {p.systemStatus && (
        <SystemStatusPanel
          status={p.systemStatus}
          accounts={p.accounts}
          defaultAccount={p.defaultAccount}
          onSetDefault={p.onSetDefaultAccount}
        />
      )}
    </>
  );
});
