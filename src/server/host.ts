import { EventEmitter } from "events";
import { ClaudeSession, SessionConfig, SessionState, StreamEvent, UsageStats } from "./session";
import { CodexSession } from "./codex-session";

export interface HostSessionHandle extends EventEmitter {
  sessionId: string | null;
  usage: UsageStats;
  readonly isRunning: boolean;
  send(message: string): Promise<void>;
  abort(): void;
  getState(): SessionState;
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
  readonly distro?: string;
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
  readonly distro?: string;
  private sessions = new Map<string, ClaudeSession | CodexSession>();

  constructor(id: string, label: string, distro?: string) {
    this.id = id;
    this.label = label;
    this.distro = distro;
  }

  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }

  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const fullConfig = { ...config, distro: this.distro };
    const session =
      fullConfig.backend === "codex"
        ? new CodexSession(fullConfig)
        : new ClaudeSession(fullConfig);
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
    const restoredState = {
      ...state,
      config: { ...state.config, distro: this.distro },
    };
    const session =
      state.config.backend === "codex"
        ? CodexSession.fromState(restoredState)
        : ClaudeSession.fromState(restoredState);
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
