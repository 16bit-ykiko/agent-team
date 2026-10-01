import { memo } from "react";
import type { AgentInfo, ModelOption, Project, Workspace } from "../state/useServer";
import { AgentAvatar } from "../workspace/avatar";
import { agentState, stateLabel } from "../workspace/agents";
import { formatRelative, formatTokens, shortModel } from "../format";
import { sessionName, sessionState, sessionWork } from "./scope";
import { Icon } from "./Icon";

export interface AgentsPanelActions {
  onOpen: (workspaceId: string) => void;
  onStop: (workspaceId: string) => void;
  onArchive: (workspaceId: string) => void;
  onRestore: (workspaceId: string) => void;
  onAddAgent: (workspaceId: string) => void;
  onClearContext: (workspaceId: string, agentId: string) => void;
  onRemoveAgent: (workspaceId: string, agentId: string) => void;
  onSetModel: (workspaceId: string, agentId: string, model: string) => void;
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
  models,
  actions,
}: {
  sessions: Workspace[];
  project: Project | undefined;
  activeWsId: string | null;
  connected: boolean;
  models: ModelOption[];
  actions: AgentsPanelActions;
}) {
  const live = sessions.filter((w) => w.archivedAt == null);
  const archived = sessions.filter((w) => w.archivedAt != null);
  return (
    <div className="agents-panel">
      {live.map((w) => (
        <SessionCard
          key={w.id}
          session={w}
          project={project}
          active={w.id === activeWsId}
          connected={connected}
          models={models}
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
              models={models}
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
  models,
  actions,
}: {
  session: Workspace;
  project: Project | undefined;
  active: boolean;
  connected: boolean;
  models: ModelOption[];
  actions: AgentsPanelActions;
}) {
  const state = sessionState(w);
  const work = project ? sessionWork(w.id, project.objectives) : [];
  // Stop ends a running turn; background work stops in the Tasks panel, and
  // a sleeping session archives like an idle one.
  const busy = state === "working" || state === "waiting";
  const name = sessionName(w, project);
  return (
    <section className={`ap-session ss-${state}${active ? " active" : ""}`} aria-label={w.name}>
      <header className="ap-session-head">
        <span className={`ap-dot ss-${state}`} title={STATE_LABEL[state]} />
        <button
          className="ap-session-name"
          title="Open this session"
          onClick={() => actions.onOpen(w.id)}
        >
          {w.projectLink?.role === "lead" && !/\blead\b/i.test(name) && (
            <span className="task-lead-tag">lead</span>
          )}
          <span className="clip" title={w.name}>
            {name}
          </span>
          {w.awaitsUser && state === "idle" && (
            <span className="awaits-tag" title="Waiting for your reply">
              your turn
            </span>
          )}
        </button>
        {state === "archived" ? (
          <button className="panel-btn" onClick={() => actions.onRestore(w.id)}>
            Restore
          </button>
        ) : state === "working" ? (
          <button className="panel-btn danger" onClick={() => actions.onStop(w.id)}>
            Stop
          </button>
        ) : (
          !busy &&
          w.projectLink?.role !== "lead" && (
            <button className="panel-btn" onClick={() => actions.onArchive(w.id)}>
              Archive
            </button>
          )
        )}
        {/* Last, so every card's time lines up at its edge, button or none. */}
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
            models={models}
            onClear={() => actions.onClearContext(w.id, a.id)}
            onRemove={() => actions.onRemoveAgent(w.id, a.id)}
            onModel={(model) => actions.onSetModel(w.id, a.id, model)}
          />
        ))}
        {state !== "archived" && (
          <button className="panel-btn ap-add" onClick={() => actions.onAddAgent(w.id)}>
            + Agent
          </button>
        )}
      </div>
    </section>
  );
}

function AgentRow({
  agent: a,
  connected,
  archived,
  models,
  onClear,
  onRemove,
  onModel,
}: {
  agent: AgentInfo;
  connected: boolean;
  archived: boolean;
  models: ModelOption[];
  onClear: () => void;
  onRemove: () => void;
  onModel: (model: string) => void;
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
            {archived || !connected || switchable(a, models).length < 2 ? (
              shortModel(a.model)
            ) : (
              <select
                className="ap-model"
                aria-label={`${a.name}'s model`}
                title="Switch model; the conversation carries over"
                value={a.model}
                onChange={(e) => onModel(e.target.value)}
              >
                {switchable(a, models).map((id) => (
                  <option key={id} value={id}>
                    {shortModel(id)}
                  </option>
                ))}
              </select>
            )}
            {a.effort ? ` · ${a.effort}` : ""}
            {a.fast ? " · ⚡" : ""}
            {a.account ? ` · @${a.account}` : ""}
          </span>
        </div>
        {(archived || state !== "idle" || !connected || bg.length > 0) && (
          <div className="ap-agent-state">
            {archived ? "archived" : stateLabel(a, connected)}
            {bg.length > 0 && state !== "waiting" && ` · ${bg.length} in background`}
          </div>
        )}
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
            <Icon name="clear" />
          </button>
          <button title="Remove" aria-label={`Remove ${a.name}`} onClick={onRemove}>
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}

// Models an agent can move to mid-session: Claude ones (the session is a
// transcript any of them resumes); a Codex thread stays on its model. The
// current one leads even when the list has dropped it.
function switchable(a: AgentInfo, models: ModelOption[]): string[] {
  if (a.model.startsWith("gpt-")) return [a.model];
  const ids = models.filter((m) => m.backend === "claude").map((m) => m.id);
  return ids.includes(a.model) ? ids : [a.model, ...ids];
}

// The last two folders of a path: enough to tell worktrees apart.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
