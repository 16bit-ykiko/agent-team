import { memo, useEffect, useState } from "react";
import type { AgentInfo, Workspace } from "../state/useServer";
import { AgentAvatar } from "../workspace/avatar";
import { agentState } from "../workspace/agents";
import { formatDuration } from "../format";
import { sessionState } from "./scope";

export interface TasksPanelActions {
  onOpen: (workspaceId: string) => void;
  onStopTask: (workspaceId: string, agentId: string, taskId: string) => void;
  onCancelWake: (workspaceId: string, agentId: string) => void;
  onStopAll: (workspaceId: string) => void;
}

const TYPE_LABEL: Record<string, string> = {
  local_bash: "shell",
  local_agent: "agent",
  monitor: "monitor",
};

// Work going on outside the turns of the sessions in scope: background
// commands and agents, each with its own stop, and scheduled wake-ups. The
// chat's Stop ends a turn and leaves all of this running.
export const TasksPanel = memo(function TasksPanel({
  sessions,
  actions,
}: {
  sessions: Workspace[];
  actions: TasksPanelActions;
}) {
  const now = useNow(1000);
  const busy = sessions.filter((w) => w.archivedAt == null && w.agents.some(hasWork));
  if (busy.length === 0) {
    return (
      <div className="tp-empty">
        Nothing runs in the background. Background commands, agents and scheduled wake-ups show up
        here, each with its own stop.
      </div>
    );
  }
  return (
    <div className="tasks-panel">
      {busy.map((w) => (
        <section key={w.id} className="tp-session" aria-label={w.name}>
          <header className="tp-session-head">
            <span className={`ap-dot ss-${sessionState(w)}`} />
            <button
              className="ap-session-name"
              title="Open this session"
              onClick={() => actions.onOpen(w.id)}
            >
              {w.name}
            </button>
            <button
              className="panel-btn danger tp-stop-all"
              title="Stop the turn, every background task and the wake-ups of this session"
              onClick={() => actions.onStopAll(w.id)}
            >
              Stop everything
            </button>
          </header>
          {w.agents.filter(hasWork).map((a) => (
            <div key={a.id} className="tp-agent">
              <div className="tp-agent-name">
                <AgentAvatar agent={a} size={18} />
                <span style={{ color: a.color }}>{a.name}</span>
              </div>
              {(a.backgroundTasks ?? []).map((t) => (
                <div key={t.id} className="tp-task">
                  <span className={`tp-type t-${t.type}`}>{TYPE_LABEL[t.type] ?? t.type}</span>
                  <span className="tp-desc" title={t.description}>
                    {t.description || t.id}
                  </span>
                  {t.since > 0 && <span className="tp-when">{elapsed(now - t.since)}</span>}
                  <button
                    className="panel-btn danger tp-stop"
                    aria-label={`Stop ${t.description || t.id}`}
                    onClick={() => actions.onStopTask(w.id, a.id, t.id)}
                  >
                    Stop
                  </button>
                </div>
              ))}
              {a.wake && (
                <div className="tp-task tp-wake">
                  <span className="tp-type t-wake">wake-up</span>
                  <span className="tp-desc" title={a.wake.reason}>
                    {a.wake.reason || "scheduled wake-up"}
                  </span>
                  <span className="tp-when" title={`at ${clock(a.wake.at)}`}>
                    in {soon(a.wake.at - now)}
                  </span>
                  {canCancelWake(a) && (
                    <button
                      className="panel-btn danger tp-stop"
                      title="A wake-up lives in the session's CLI process: cancelling closes it, and the session resumes on the next message"
                      onClick={() => actions.onCancelWake(w.id, a.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
});

// A wake-up is cancelled by closing the CLI process: not while a turn runs
// in it, nor while background tasks do (the server refuses both).
function canCancelWake(a: AgentInfo): boolean {
  return agentState(a) !== "working" && (a.backgroundTasks?.length ?? 0) === 0;
}

export function hasWork(a: AgentInfo): boolean {
  return (a.backgroundTasks?.length ?? 0) > 0 || !!a.wake;
}

export function workCount(sessions: Workspace[]): number {
  let n = 0;
  for (const w of sessions) {
    if (w.archivedAt != null) continue;
    for (const a of w.agents) n += (a.backgroundTasks?.length ?? 0) + (a.wake ? 1 : 0);
  }
  return n;
}

// Whole seconds: a clock ticking every second should not flicker tenths.
function elapsed(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms / 1000) * 1000));
}

// A countdown to the minute; seconds only in the last one.
function soon(ms: number): string {
  if (ms < 60_000) return elapsed(ms);
  const mins = Math.ceil(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The time, refreshed every `ms` while mounted (elapsed times, countdowns).
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
