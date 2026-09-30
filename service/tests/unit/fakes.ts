// In-memory stand-ins for the CLI sessions a Workspace drives: they record
// what was sent and never start a process.
import { EventEmitter } from "events";
import type { Host, HostSessionHandle, HostInfo } from "../../src/session/host";
import type { SessionConfig, SessionState, UsageStats } from "../../src/session/claude";
import type { PanelToolset } from "../../src/project/tools";

const emptyUsage: UsageStats = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

export class FakeSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  usage: UsageStats = { ...emptyUsage };
  isRunning = false;
  stoppedTasks: string[] = [];
  constructor(private config: SessionConfig) {
    super();
  }
  sent: string[] = [];
  send(prompt: string): Promise<void> {
    this.sent.push(prompt);
    this.isRunning = true;
    return Promise.resolve();
  }
  abort(): void {}
  stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    return Promise.resolve();
  }
  setFastMode(on: boolean): void {
    this.config.fast = on || undefined;
  }
  providerEnv: Record<string, string> | undefined;
  setModel(model: string, effort: string | undefined, fast: boolean): void {
    this.config.model = model;
    this.config.effort = effort;
    this.config.fast = fast || undefined;
  }
  setProviderEnv(env: Record<string, string> | undefined): void {
    this.providerEnv = env;
  }
  setGoal(goal: string | null): void {
    this.config.goal = goal ?? undefined;
  }
  panelTools: PanelToolset | null = null;
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
  }
  getState(): SessionState {
    return { sessionId: this.sessionId, config: this.config, usage: this.usage };
  }
}

export class FakeHost implements Host {
  readonly id = "local";
  readonly label = "Local";
  readonly type = "local" as const;
  readonly connected = true;
  lastSession: FakeSession | null = null;
  destroyed: string[] = [];
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(_agentId: string, config: SessionConfig): HostSessionHandle {
    this.lastSession = new FakeSession(config);
    return this.lastSession;
  }
  destroySession(agentId: string): void {
    this.destroyed.push(agentId);
  }
  restoreSession(_agentId: string, state: SessionState): HostSessionHandle {
    this.lastSession = new FakeSession(state.config);
    return this.lastSession;
  }
}
