import { EventEmitter } from "events";
import {
  ClaudeSession,
  RunState,
  SessionConfig,
  SessionState,
  UsageStats,
  BackgroundTask,
} from "./claude-session";
import { CodexSession } from "./codex-session";

export interface HostSessionHandle extends EventEmitter {
  sessionId: string | null;
  usage: UsageStats;
  readonly isRunning: boolean;
  // Richer than isRunning; sessions that don't track it fall back to it.
  readonly runState?: RunState;
  // Effort in force when none was set explicitly (backend default).
  readonly effectiveEffort?: string | null;
  // Live background tasks (Claude: background Bash, subagents, Monitor).
  readonly backgroundTaskList?: BackgroundTask[];
  send(message: string): Promise<void>;
  abort(): void;
  setEffort?(level: string): void;
  setFastMode?(on: boolean): void;
  setGoal?(goal: string | null): void;
  stopTask?(taskId: string): Promise<void>;
  simulateRateLimit?(info: { rateLimitType?: string; resetsAt?: number }): void;
  setProviderEnv?(env: Record<string, string> | undefined): void;
  getState(): SessionState;
  getContextUsage?(): Promise<Record<string, unknown> | null>;
  getUsageInfo?(): Promise<Record<string, unknown> | null>;
}

export interface HostInfo {
  id: string;
  label: string;
  type: "local" | "remote";
  connected: boolean;
}

export interface Host {
  readonly id: string;
  readonly label: string;
  readonly type: "local" | "remote";
  readonly connected: boolean;
  getInfo(): HostInfo;
  createSession(agentId: string, config: SessionConfig): HostSessionHandle;
  destroySession(agentId: string): void;
  restoreSession(agentId: string, state: SessionState): HostSessionHandle;
}

export class LocalHost implements Host {
  readonly id: string;
  readonly label: string;
  readonly type = "local" as const;
  readonly connected = true;
  private sessions = new Map<string, ClaudeSession | CodexSession>();

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }

  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const session =
      config.backend === "codex" ? new CodexSession(config) : new ClaudeSession(config);
    this.sessions.set(agentId, session);
    return session;
  }

  destroySession(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (s) {
      s.abort();
      this.sessions.delete(agentId);
    }
  }

  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    const session =
      state.config.backend === "codex"
        ? CodexSession.fromState(state)
        : ClaudeSession.fromState(state);
    this.sessions.set(agentId, session);
    return session;
  }
}

export class HostRegistry {
  private hosts = new Map<string, Host>();

  register(host: Host): void {
    this.hosts.set(host.id, host);
  }

  get(id: string): Host | undefined {
    return this.hosts.get(id);
  }

  getDefault(): Host | undefined {
    for (const host of this.hosts.values()) {
      if (host.type === "local") return host;
    }
    return this.hosts.values().next().value;
  }

  getAll(): Host[] {
    return [...this.hosts.values()];
  }

  getAllInfo(): HostInfo[] {
    return this.getAll().map((h) => h.getInfo());
  }
}
