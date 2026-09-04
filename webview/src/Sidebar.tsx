import { useState } from "react";
import type { Workspace, SystemStatus, SearchHit } from "./useServer";
import { groupWorkspaces, isGroupExpanded, archivedWorkspaces } from "./groups";
import { isAgentActive } from "./agents";
import { formatBytes, formatRelative, formatResetTime } from "./format";
import { ViewportInfo } from "./ViewportInfo";

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
  onToggleGroup: (key: string, expanded: boolean) => void;
  onSearchChange: (q: string) => void;
  onJump: (wsId: string, msgId: string) => void;
  onCreate: () => void;
  // Create a workspace in a group's folder (the "+" on the group header).
  onCreateIn: (cwd: string) => void;
  onReplayDemo: () => void;
  onPurgeArchived: () => void;
  onSetDefaultAccount: (account: string | null) => void;
}

export function Sidebar(p: SidebarProps) {
  const now = p.now ?? Date.now();
  const groups = groupWorkspaces(p.workspaces);
  const archived = archivedWorkspaces(p.workspaces);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeIsArchived = archived.some((w) => w.id === p.activeWsId);
  const showArchived = archivedOpen || activeIsArchived;

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
            ▶
          </button>
          <button title="New workspace" onClick={p.onCreate}>
            +
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
          {groups.map((g) => {
            const expanded = isGroupExpanded(
              g,
              p.groupOverrides,
              now,
              g.workspaces.some((w) => w.id === p.activeWsId),
            );
            return (
              <div key={g.key} className="ws-group">
                <div
                  className="ws-group-header"
                  title={g.key}
                  onClick={() => p.onToggleGroup(g.key, !expanded)}
                >
                  <span className="events-toggle">{expanded ? "▾" : "▸"}</span>
                  <span className="ws-group-label">{g.label}</span>
                  {g.workspaces[0].git?.branch && (
                    <span className="ws-group-branch" title={gitTitle(g.workspaces[0].git)}>
                      {g.workspaces[0].git.branch}
                      {g.workspaces[0].git.dirty > 0 && <span className="ws-group-dirty">●</span>}
                    </span>
                  )}
                  <button
                    className="ws-group-add"
                    title={`New workspace in ${g.key}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onCreateIn(g.key);
                    }}
                  >
                    +
                  </button>
                  <span className="ws-group-count">{g.workspaces.length}</span>
                  {g.running && <span className="streaming-dot" />}
                </div>
                {expanded && (
                  <div className="ws-group-items">
                    {g.workspaces.map((ws) => {
                      const activeAgents = ws.agents.filter(isAgentActive);
                      const running = activeAgents.length > 0;
                      const unread = ws.messages.length - (p.seenCounts[ws.id] ?? 0);
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
                                {ws.name}
                                {unread > 0 && ws.id !== p.activeWsId && (
                                  <span className="unread-badge">{unread}</span>
                                )}
                              </span>
                              <span className="task-time">
                                {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
                              </span>
                            </div>
                            {activeAgents.length > 0 && (
                              <div className="task-active-agents">
                                {activeAgents.map((a) => (
                                  <span
                                    key={a.id}
                                    className="task-active-agent"
                                    style={{ background: a.color }}
                                    title={a.activity ?? undefined}
                                  >
                                    {a.name}
                                    {a.activity ? ` · ${a.activity}` : ""}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <button
                            className="task-delete"
                            title="Delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              p.onDelete(ws.id);
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {archived.length > 0 && (
            <div className="ws-group ws-archived">
              <div
                className="ws-group-header ws-archived-header"
                onClick={() => setArchivedOpen((v) => !v)}
                title="Idle workspaces. History stays on disk; sending a message restores one."
              >
                <span className="events-toggle">{showArchived ? "▾" : "▸"}</span>
                <span className="ws-group-label">Archived</span>
                <span className="ws-group-count">{archived.length}</span>
                <button
                  className="ws-archived-purge"
                  title="Delete all archived workspaces"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onPurgeArchived();
                  }}
                >
                  Clear
                </button>
              </div>
              {showArchived && (
                <div className="ws-group-items">
                  {archived.map((ws) => (
                    <div
                      key={ws.id}
                      className={`task-item task-item-archived ${ws.id === p.activeWsId ? "active" : ""}`}
                      onClick={() => p.onSelect(ws.id)}
                      title={ws.cwd}
                    >
                      <div className="task-status idle" />
                      <div className="task-info">
                        <div className="task-name">
                          <span className="task-name-text">{ws.name}</span>
                          <span className="task-time">
                            {formatRelative(ws.lastMessageAt ?? ws.createdAt, now)}
                          </span>
                        </div>
                        <div className="task-meta">{ws.project}</div>
                      </div>
                      <button
                        className="task-delete"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onDelete(ws.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
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
      <ViewportInfo />
    </>
  );
}
