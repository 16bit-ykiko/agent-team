import { memo } from "react";
import type { AgentInfo, Project, Workspace } from "../state/useServer";
import { AgentAvatar } from "../workspace/avatar";
import { agentState, stateLabel } from "../workspace/agents";
import { formatRelative, formatTokens, shortModel } from "../format";
import { sessionState, sessionWork, stateSummary } from "./scope";

export interface AgentsPanelActions {
  onOpen: (workspaceId: string) => void;
  onStop: (workspaceId: string) => void;
  onArchive: (workspaceId: string) => void;
  onRestore: (workspaceId: string) => void;
  onAddAgent: (workspaceId: string) => void;
  onClearContext: (workspaceId: string, agentId: string) => void;
  onRemoveAgent: (workspaceId: string, agentId: string) => void;
}

const STATE_LABEL = {
  working: "working",
  waiting: "waiting on background work",
  sleeping: "sleeping",
  idle: "idle",
  archived: "archived",
};

// Every session in scope (the project's, or the open workspace) with what
// its agents are doing: state, the objective or task it carries out, model,
// context. Opening, stopping and archiving sessions, and adding, clearing or
// removing agents happen here.
export const AgentsPanel = memo(function AgentsPanel({
  sessions,
  project,
  activeWsId,
  connected,
  actions,
}: {
  sessions: Workspace[];
  project: Project | undefined;
  activeWsId: string | null;
  connected: boolean;
  actions: AgentsPanelActions;
}) {
  const live = sessions.filter((w) => w.archivedAt == null);
  const archived = sessions.filter((w) => w.archivedAt != null);
  return (
    <div className="agents-panel">
      {project && (
        <div className="ap-summary">
          {project.name} · {live.length} session{live.length === 1 ? "" : "s"} ·{" "}
          {stateSummary(live.map(sessionState))}
        </div>
      )}
      {live.map((w) => (
        <SessionCard
          key={w.id}
          session={w}
          project={project}
          active={w.id === activeWsId}
          connected={connected}
          actions={actions}
        />
      ))}
      {archived.length > 0 && (
        <details className="ap-archived">
          <summary>Archived · {archived.length}</summary>
          {archived.map((w) => (
            <SessionCard
              key={w.id}
              session={w}
              project={project}
              active={w.id === activeWsId}
              connected={connected}
              actions={actions}
            />
          ))}
        </details>
      )}
    </div>
  );
});

function SessionCard({
  session: w,
  project,
  active,
  connected,
  actions,
}: {
  session: Workspace;
  project: Project | undefined;
  active: boolean;
  connected: boolean;
  actions: AgentsPanelActions;
}) {
  const state = sessionState(w);
  const work = project ? sessionWork(w.id, project.objectives) : [];
  const busy = state === "working" || state === "waiting" || state === "sleeping";
  return (
    <section className={`ap-session ss-${state}${active ? " active" : ""}`} aria-label={w.name}>
      <header className="ap-session-head">
        <span className={`ap-dot ss-${state}`} title={STATE_LABEL[state]} />
        <button
          className="ap-session-name"
          title="Open this session"
          onClick={() => actions.onOpen(w.id)}
        >
          {w.projectLink?.role === "lead" && <span className="task-lead-tag">lead</span>}
          {w.name}
        </button>
        <span className="ap-when">{formatRelative(w.lastMessageAt ?? w.createdAt)}</span>
      </header>
      <div className="ap-where" title={w.cwd}>
        {w.git?.branch && <span className="ap-branch">{w.git.branch}</span>}
        {w.git && w.git.dirty > 0 && <span className="ap-dirty">{w.git.dirty} changed</span>}
        <span className="ap-cwd">{shortPath(w.cwd)}</span>
      </div>
      {work.map(({ objective, task }) => (
        <div key={objective.id} className="ap-work" title={objective.goal}>
          ◆ {objective.title}
          {task && <span className="ap-task"> · {task.text}</span>}
        </div>
      ))}
      <div className="ap-agents">
        {w.agents.length === 0 && <div className="ap-none">No agents.</div>}
        {w.agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            connected={connected}
            archived={state === "archived"}
            onClear={() => actions.onClearContext(w.id, a.id)}
            onRemove={() => actions.onRemoveAgent(w.id, a.id)}
          />
        ))}
      </div>
      <footer className="ap-actions">
        {state === "archived" ? (
          <button className="btn-inline" onClick={() => actions.onRestore(w.id)}>
            Restore
          </button>
        ) : (
          <>
            <button className="btn-inline" onClick={() => actions.onAddAgent(w.id)}>
              + Agent
            </button>
            {busy && (
              <button className="btn-inline ap-stop" onClick={() => actions.onStop(w.id)}>
                Stop
              </button>
            )}
            {!busy && (
              <button className="btn-inline" onClick={() => actions.onArchive(w.id)}>
                Archive
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

function AgentRow({
  agent: a,
  connected,
  archived,
  onClear,
  onRemove,
}: {
  agent: AgentInfo;
  connected: boolean;
  archived: boolean;
  onClear: () => void;
  onRemove: () => void;
}) {
  const state = agentState(a);
  const ctx = a.context;
  const pct = ctx && ctx.window ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  const bg = a.backgroundTasks ?? [];
  return (
    <div className={`ap-agent as-${state}`}>
      <AgentAvatar agent={a} size={22} />
      <div className="ap-agent-main">
        <div className="ap-agent-top">
          <span className="ap-agent-name" style={{ color: a.color }}>
            {a.name}
          </span>
          <span className="ap-meta">
            {shortModel(a.model)}
            {a.effort ? ` · ${a.effort}` : ""}
            {a.fast ? " · ⚡" : ""}
            {a.account ? ` · @${a.account}` : ""}
          </span>
        </div>
        <div className="ap-agent-state">
          {archived ? "archived" : stateLabel(a, connected)}
          {bg.length > 0 && state !== "waiting" && ` · ${bg.length} in background`}
        </div>
        {a.goal && <div className="ap-goal">🎯 {a.goal}</div>}
        {ctx && pct !== null && (
          <div
            className="ap-context"
            title={`${ctx.tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens`}
          >
            <span className="ap-context-bar">
              <span style={{ width: `${pct}%` }} className={pct >= 80 ? "high" : ""} />
            </span>
            {formatTokens(ctx.tokens)} / {formatTokens(ctx.window)}
          </div>
        )}
      </div>
      {!archived && (
        <div className="ap-agent-actions">
          <button title="Clear context" aria-label={`Clear ${a.name}'s context`} onClick={onClear}>
            ↻
          </button>
          <button title="Remove" aria-label={`Remove ${a.name}`} onClick={onRemove}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// The last two folders of a path: enough to tell worktrees apart.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
