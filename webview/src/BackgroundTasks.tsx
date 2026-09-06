import { useEffect, useState } from "react";
import type { AgentInfo, BackgroundTask } from "./useServer";
import { AgentAvatar } from "./avatar";

const TASK_TYPE_LABEL: Record<string, string> = {
  local_bash: "shell",
  local_agent: "agent",
  local_monitor: "monitor",
  local_workflow: "workflow",
};

export function taskTypeLabel(type: string): string {
  return TASK_TYPE_LABEL[type] ?? type.replace(/^local_/, "") ?? "task";
}

export function elapsedLabel(since: number, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface BackgroundTaskRow {
  agent: AgentInfo;
  task: BackgroundTask;
}

export function backgroundTaskRows(agents: AgentInfo[]): BackgroundTaskRow[] {
  return agents.flatMap((agent) => (agent.backgroundTasks ?? []).map((task) => ({ agent, task })));
}

// Strip above the composer: what each agent is waiting on right now. The
// CLI re-invokes the agent when a task settles, so this is informational —
// the composer still sends immediately.
export function BackgroundTasksBar({ agents }: { agents: AgentInfo[] }) {
  const rows = backgroundTaskRows(agents);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (rows.length === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [rows.length]);
  if (rows.length === 0) return null;
  return (
    <div className="bg-tasks-bar" role="status">
      {rows.map(({ agent, task }) => (
        <div key={task.id} className="bg-task" title={`${agent.name}: ${task.description}`}>
          <AgentAvatar agent={agent} size={16} />
          <span className="bg-task-type">{taskTypeLabel(task.type)}</span>
          <span className="bg-task-desc">{task.description || "background task"}</span>
          <span className="bg-task-elapsed">{elapsedLabel(task.since, now)}</span>
        </div>
      ))}
    </div>
  );
}
