import { ClaudeSession, SessionConfig, StreamEvent, SessionState } from "./session";

export type MessageStatus = "streaming" | "done" | "error";

export interface Message {
  id: string;
  agentId: string | null; // null = user
  content: string;
  timestamp: number;
  status: MessageStatus;
  events?: StreamEvent[];
}

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  avatar: string;
  color: string;
  isDefault: boolean;
}

export interface AgentState extends AgentInfo {
  session: SessionState;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  project: string;
  cwd: string;
  agents: AgentInfo[];
  messages: Message[];
  createdAt: number;
}

export interface WorkspaceState {
  id: string;
  name: string;
  project: string;
  cwd: string;
  agents: AgentState[];
  messages: Message[];
  createdAt: number;
}

export interface AgentEntry {
  info: AgentInfo;
  session: ClaudeSession;
}

export interface WorkspaceCallbacks {
  onNewMessage: (wsId: string, msg: Message) => void;
  onStreamEvent: (wsId: string, msg: Message, event: StreamEvent) => void;
  onMessageDone: (wsId: string, msgId: string, status: MessageStatus, content: string) => void;
}

export class Workspace {
  id: string;
  name: string;
  project: string;
  cwd: string;
  agents = new Map<string, AgentEntry>();
  messages: Message[] = [];
  createdAt: number;

  private cb?: WorkspaceCallbacks;

  constructor(
    id: string,
    name: string,
    project: string,
    cwd: string,
    cb?: WorkspaceCallbacks,
  ) {
    this.id = id;
    this.name = name;
    this.project = project;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.cb = cb;
  }

  addAgent(name: string, model: string, avatar: string, color: string, config: Partial<SessionConfig>): AgentInfo {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isDefault = this.agents.size === 0;

    const info: AgentInfo = { id, name, model, avatar, color, isDefault };
    const session = new ClaudeSession({
      cwd: this.cwd,
      model,
      ...config,
    });

    this.agents.set(id, { info, session });
    return info;
  }

  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    entry.session.abort();
    this.agents.delete(agentId);

    if (entry.info.isDefault && this.agents.size > 0) {
      const first = this.agents.values().next().value!;
      first.info.isDefault = true;
    }

    return true;
  }

  setDefaultAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    for (const a of this.agents.values()) {
      a.info.isDefault = a.info.id === agentId;
    }
    return true;
  }

  resolveAgent(target?: string): AgentEntry | null {
    if (target) {
      for (const entry of this.agents.values()) {
        if (entry.info.id === target || entry.info.name === target) {
          return entry;
        }
      }
      return null;
    }
    for (const entry of this.agents.values()) {
      if (entry.info.isDefault) return entry;
    }
    return null;
  }

  async sendMessage(content: string, target?: string): Promise<void> {
    const agent = this.resolveAgent(target);
    if (!agent) throw new Error(target ? `Agent not found: ${target}` : "No default agent");
    if (agent.session.isRunning) throw new Error(`Agent ${agent.info.name} is busy`);

    const userMsg: Message = {
      id: genId("msg"),
      agentId: null,
      content,
      timestamp: Date.now(),
      status: "done",
    };
    this.messages.push(userMsg);
    this.cb?.onNewMessage(this.id, userMsg);

    const agentMsg: Message = {
      id: genId("msg"),
      agentId: agent.info.id,
      content: "",
      timestamp: Date.now(),
      status: "streaming",
      events: [],
    };
    this.messages.push(agentMsg);
    this.cb?.onNewMessage(this.id, agentMsg);

    const eventHandler = (event: StreamEvent) => {
      agentMsg.events!.push(event);
      if (event.kind === "text") {
        agentMsg.content = event.content;
      }
      this.cb?.onStreamEvent(this.id, agentMsg, event);
    };

    agent.session.on("event", eventHandler);

    try {
      await agent.session.send(content);
      agentMsg.status = "done";
    } catch {
      agentMsg.status = "error";
    } finally {
      agent.session.off("event", eventHandler);
      this.cb?.onMessageDone(this.id, agentMsg.id, agentMsg.status, agentMsg.content);
    }
  }

  abortAgent(agentId: string): void {
    this.agents.get(agentId)?.session.abort();
  }

  abortAll(): void {
    for (const entry of this.agents.values()) {
      entry.session.abort();
    }
  }

  getInfo(): WorkspaceInfo {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      cwd: this.cwd,
      agents: [...this.agents.values()].map((a) => a.info),
      messages: this.messages,
      createdAt: this.createdAt,
    };
  }

  getState(): WorkspaceState {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      cwd: this.cwd,
      agents: [...this.agents.values()].map((a) => ({
        ...a.info,
        session: a.session.getState(),
      })),
      messages: this.messages.map((m) => ({ ...m, events: undefined })),
      createdAt: this.createdAt,
    };
  }

  static fromState(
    state: WorkspaceState,
    cb?: WorkspaceCallbacks,
  ): Workspace {
    const ws = new Workspace(state.id, state.name, state.project, state.cwd, cb);
    ws.createdAt = state.createdAt;
    ws.messages = state.messages;

    for (const agentState of state.agents) {
      const session = ClaudeSession.fromState(agentState.session);
      ws.agents.set(agentState.id, {
        info: {
          id: agentState.id,
          name: agentState.name,
          model: agentState.model,
          avatar: agentState.avatar,
          color: agentState.color,
          isDefault: agentState.isDefault,
        },
        session,
      });
    }

    return ws;
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
