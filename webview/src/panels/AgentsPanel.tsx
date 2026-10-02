import { Fragment, memo, useState } from "react";
import type { AgentInfo, ModelOption, Project, Workspace } from "../state/useServer";
import { AgentAvatar } from "../workspace/avatar";
import { agentState, stateLabel } from "../workspace/agents";
import { formatRelative, formatTokens, shortModel } from "../format";
import { DEFAULT_BRANCH, sessionName, sessionState, sessionWork } from "./scope";
import { AgentTasks, hasWork, soon, workCount, type TaskActions } from "./SessionTasks";
import { Icon } from "./Icon";
import { InlineMd } from "../chat/markdown";

export interface AgentsPanelActions extends TaskActions {
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

// The sessions in scope with what their agents are doing. In a project's
// overview (from its lead) every session is a card of two lines, unfolded
// for the rest: where it works, its objectives, each agent's model and
// context, its background work. A single session's card comes unfolded.
// Opening, stopping and archiving sessions, adding, clearing or removing
// agents, and stopping background work happen here.
export const AgentsPanel = memo(function AgentsPanel({
  sessions,
  project,
  activeWsId,
  connected,
  models,
  actions,
  overview = false,
}: {
  sessions: Workspace[];
  project: Project | undefined;
  activeWsId: string | null;
  connected: boolean;
  models: ModelOption[];
  actions: AgentsPanelActions;
  overview?: boolean;
}) {
  const live = sessions.filter((w) => w.archivedAt == null);
  const archived = sessions.filter((w) => w.archivedAt != null);
  // Keyed by the view too: a card folded in the overview comes unfolded
  // when its own session is the one open.
  const card = (w: Workspace) => (
    <SessionCard
      key={`${overview ? "overview" : "own"}:${w.id}`}
      session={w}
      project={project}
      active={w.id === activeWsId}
      connected={connected}
      models={models}
      actions={actions}
      defaultOpen={!overview}
    />
  );
  return (
    <div className="agents-panel">
      {live.map(card)}
      {archived.length > 0 && (
        <details className="ap-archived">
          <summary>Archived · {archived.length}</summary>
          {archived.map(card)}
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
  defaultOpen,
}: {
  session: Workspace;
  project: Project | undefined;
  active: boolean;
  connected: boolean;
  models: ModelOption[];
  actions: AgentsPanelActions;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const state = sessionState(w);
  const work = project ? sessionWork(w.id, project.objectives) : [];
  // Stop ends a running turn; background work has its own stops, and a
  // sleeping session archives like an idle one.
  const busy = state === "working" || state === "waiting";
  const name = sessionName(w, project);
  const tasks = workCount([w]);
  // Where it works, when that is not the project's own checkout.
  const branch = w.git?.branch;
  const elsewhere =
    !!project && (w.cwd !== project.root || (!!branch && !DEFAULT_BRANCH.test(branch)));
  const stop = (
    <button className="panel-btn danger" onClick={() => actions.onStop(w.id)}>
      Stop
    </button>
  );
  return (
    <section
      className={`ap-session ss-${state}${active ? " active" : ""}${open ? " open" : ""}`}
      aria-label={w.name}
    >
      <header className="ap-session-head">
        <button
          className="ap-toggle"
          aria-expanded={open}
          aria-label={open ? `Fold ${name}` : `Unfold ${name}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"}
        </button>
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
        <span className="ap-when">{formatRelative(w.lastMessageAt ?? w.createdAt)}</span>
      </header>
      {!open && (
        <div className="ap-brief">
          {w.agents.map((a) => (
            <span key={a.id} className="ap-brief-agent">
              <AgentAvatar agent={a} size={16} />
              <span className="clip" style={{ color: a.color }}>
                {a.name}
              </span>
              <span className={`ap-brief-meta as-${agentState(a)}`}>{brief(a, connected)}</span>
            </span>
          ))}
          {tasks > 0 && <span className="ap-brief-tasks">{tasksTag(w)}</span>}
          {state === "working" && <span className="ap-actions">{stop}</span>}
        </div>
      )}
      {open && (
        <>
          {(elsewhere || work.length > 0) && (
            <div className="ap-info">
              {elsewhere && (
                <div className="ap-where" title={w.cwd}>
                  {branch && <span className="ap-branch">{branch}</span>}
                  {w.git && w.git.dirty > 0 && (
                    <span className="ap-dirty">{w.git.dirty} changed</span>
                  )}
                  <span className="ap-cwd">{shortPath(w.cwd)}</span>
                </div>
              )}
              {work.map(({ objective, task }) => (
                <div key={objective.id} className="ap-work" title={objective.goal}>
                  <span className="ap-work-title">
                    <InlineMd>{objective.title}</InlineMd>
                  </span>
                  {task && (
                    <span className="ap-task">
                      <InlineMd>{task.text}</InlineMd>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="ap-agents">
            {w.agents.length === 0 && <div className="ap-none">No agents.</div>}
            {w.agents.map((a) => (
              <Fragment key={a.id}>
                <AgentRow
                  agent={a}
                  connected={connected}
                  archived={state === "archived"}
                  models={models}
                  onClear={() => actions.onClearContext(w.id, a.id)}
                  onRemove={() => actions.onRemoveAgent(w.id, a.id)}
                  onModel={(model) => actions.onSetModel(w.id, a.id, model)}
                />
                {state !== "archived" && hasWork(a) && (
                  <AgentTasks session={w} agent={a} actions={actions} />
                )}
              </Fragment>
            ))}
          </div>
          <footer className="ap-session-foot">
            {state !== "archived" && (
              <button className="panel-btn ap-add" onClick={() => actions.onAddAgent(w.id)}>
                + Agent
              </button>
            )}
            <span className="ap-actions">
              {tasks > 0 && (
                <button
                  className="panel-btn danger"
                  title="Stop the turn, every background task and the wake-ups of this session"
                  onClick={() => actions.onStopAll(w.id)}
                >
                  Stop everything
                </button>
              )}
              {state === "archived" ? (
                <button className="panel-btn" onClick={() => actions.onRestore(w.id)}>
                  Restore
                </button>
              ) : state === "working" ? (
                stop
              ) : (
                !busy &&
                w.projectLink?.role !== "lead" && (
                  <button className="panel-btn" onClick={() => actions.onArchive(w.id)}>
                    Archive
                  </button>
                )
              )}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}

// An agent in a folded card: what it is doing, or how full its context is.
function brief(a: AgentInfo, connected: boolean): string {
  if (agentState(a) !== "idle") return stateLabel(a, connected);
  return a.context ? formatTokens(a.context.tokens) : "";
}

// A folded card's background work: how much runs, and the next wake-up.
function tasksTag(w: Workspace): string {
  const running = w.agents.reduce((n, a) => n + (a.backgroundTasks?.length ?? 0), 0);
  const wakes = w.agents.flatMap((a) => (a.wake ? [a.wake.at] : []));
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} in background`);
  if (wakes.length > 0) parts.push(`wake in ${soon(Math.min(...wakes) - Date.now())}`);
  return parts.join(" · ");
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
