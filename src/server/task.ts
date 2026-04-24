import { ClaudeSession, SessionConfig, StreamEvent, SessionState } from "./session";

export interface Message {
  id: string;
  role: "user" | "planner" | "coder" | "reviewer" | "validator" | "system";
  content: string;
  timestamp: number;
  events?: StreamEvent[];
}

export type TaskStatus = "idle" | "running" | "done" | "failed";

export interface TaskInfo {
  id: string;
  name: string;
  project: string;
  cwd: string;
  status: TaskStatus;
  messages: Message[];
  createdAt: number;
}

export interface TaskState {
  id: string;
  name: string;
  project: string;
  cwd: string;
  status: TaskStatus;
  messages: Message[];
  createdAt: number;
  sessions: Record<string, SessionState>;
}

export class Task {
  id: string;
  name: string;
  project: string;
  cwd: string;
  status: TaskStatus = "idle";
  messages: Message[] = [];
  createdAt: number;
  sessions: Map<string, ClaudeSession> = new Map();

  private onEvent?: (taskId: string, msg: Message, event: StreamEvent) => void;

  constructor(
    id: string,
    name: string,
    project: string,
    cwd: string,
    agentConfigs: Record<string, SessionConfig>,
    onEvent?: (taskId: string, msg: Message, event: StreamEvent) => void,
  ) {
    this.id = id;
    this.name = name;
    this.project = project;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.onEvent = onEvent;

    for (const [role, config] of Object.entries(agentConfigs)) {
      const session = new ClaudeSession({ ...config, cwd });
      this.sessions.set(role, session);
    }
  }

  async sendToAgent(role: string, content: string, userMessage?: Message): Promise<Message> {
    const session = this.sessions.get(role);
    if (!session) throw new Error(`No session for role: ${role}`);

    if (userMessage) {
      this.messages.push(userMessage);
    }

    const agentMsg: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: role as Message["role"],
      content: "",
      timestamp: Date.now(),
      events: [],
    };
    this.messages.push(agentMsg);

    this.status = "running";

    const eventHandler = (event: StreamEvent) => {
      agentMsg.events!.push(event);
      if (event.kind === "text" || event.kind === "result") {
        agentMsg.content += event.content;
      }
      this.onEvent?.(this.id, agentMsg, event);
    };

    session.on("event", eventHandler);

    try {
      await session.send(content);
      this.status = "idle";
    } catch {
      this.status = "failed";
    } finally {
      session.off("event", eventHandler);
    }

    return agentMsg;
  }

  abortAgent(role: string): void {
    const session = this.sessions.get(role);
    if (session) session.abort();
  }

  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abort();
    }
  }

  getInfo(): TaskInfo {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      cwd: this.cwd,
      status: this.status,
      messages: this.messages,
      createdAt: this.createdAt,
    };
  }

  getState(): TaskState {
    const sessions: Record<string, SessionState> = {};
    for (const [role, session] of this.sessions) {
      sessions[role] = session.getState();
    }
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      cwd: this.cwd,
      status: this.status === "running" ? "idle" : this.status,
      messages: this.messages,
      createdAt: this.createdAt,
      sessions,
    };
  }

  static fromState(
    state: TaskState,
    onEvent?: (taskId: string, msg: Message, event: StreamEvent) => void,
  ): Task {
    const task = new Task(state.id, state.name, state.project, state.cwd, {}, onEvent);
    task.status = state.status;
    task.messages = state.messages;
    task.createdAt = state.createdAt;

    for (const [role, sessionState] of Object.entries(state.sessions)) {
      task.sessions.set(role, ClaudeSession.fromState(sessionState));
    }

    return task;
  }
}
