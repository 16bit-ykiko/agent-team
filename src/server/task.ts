import { execSync } from "child_process";
import { ClaudeSession, SessionConfig, StreamEvent, SessionState } from "./session";

export type MessageStatus = "streaming" | "done" | "error";
export type MessageKind = "user" | "agent" | "system";

export interface MessageImage {
  name: string;
  url: string;
}

export interface Message {
  id: string;
  kind: MessageKind;
  agentId: string | null;
  content: string;
  timestamp: number;
  status: MessageStatus;
  events?: StreamEvent[];
  turnId?: string;
  images?: MessageImage[];
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
  gitBranch: string | null;
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
  onAgentBusy?: (wsId: string, agentId: string) => void;
  onAgentIdle?: (wsId: string, agentId: string) => void;
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

  constructor(id: string, name: string, project: string, cwd: string, cb?: WorkspaceCallbacks) {
    this.id = id;
    this.name = name;
    this.project = project;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.cb = cb;
  }

  private pushSystemMessage(content: string): void {
    const msg: Message = {
      id: genId("msg"),
      kind: "system",
      agentId: null,
      content,
      timestamp: Date.now(),
      status: "done",
    };
    this.messages.push(msg);
    this.cb?.onNewMessage(this.id, msg);
  }

  addAgent(
    name: string,
    model: string,
    avatar: string,
    color: string,
    config: Partial<SessionConfig>,
  ): AgentInfo {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isDefault = this.agents.size === 0;

    const info: AgentInfo = { id, name, model, avatar, color, isDefault };
    const session = new ClaudeSession({
      cwd: this.cwd,
      model,
      ...config,
    });

    this.agents.set(id, { info, session });
    this.pushSystemMessage(`${avatar} **${name}** joined the team`);
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

    this.pushSystemMessage(`${entry.info.avatar} **${entry.info.name}** left the team`);
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

  async sendMessage(
    content: string,
    target?: string,
    images?: Array<{ name: string; url: string; path: string }>,
  ): Promise<void> {
    let resolvedTarget = target;
    let cleanContent = content;
    const mentionMatch = content.match(/^@(\S+)\s+/);
    if (mentionMatch) {
      if (!resolvedTarget) resolvedTarget = mentionMatch[1];
      cleanContent = content.slice(mentionMatch[0].length);
    }

    const agent = this.resolveAgent(resolvedTarget);
    if (!agent)
      throw new Error(resolvedTarget ? `Agent not found: ${resolvedTarget}` : "No default agent");
    if (agent.session.isRunning) throw new Error(`Agent ${agent.info.name} is busy`);

    const msgImages = images?.map(({ name, url }) => ({ name, url }));

    const userMsg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content,
      timestamp: Date.now(),
      status: "done",
      images: msgImages?.length ? msgImages : undefined,
    };
    this.messages.push(userMsg);
    this.cb?.onNewMessage(this.id, userMsg);

    const turnId = genId("turn");

    const makeAgentMsg = (): Message => ({
      id: genId("msg"),
      kind: "agent",
      agentId: agent.info.id,
      content: "",
      timestamp: Date.now(),
      status: "streaming",
      events: [],
      turnId,
    });

    let currentMsg = makeAgentMsg();
    this.messages.push(currentMsg);
    this.cb?.onNewMessage(this.id, currentMsg);

    let textFinalized = false;

    const eventHandler = (event: StreamEvent) => {
      if (event.kind === "text") {
        currentMsg.content = event.content;
        currentMsg.status = "done";
        this.cb?.onMessageDone(this.id, currentMsg.id, "done", event.content);
        textFinalized = true;
      } else {
        if (textFinalized) {
          currentMsg = makeAgentMsg();
          this.messages.push(currentMsg);
          this.cb?.onNewMessage(this.id, currentMsg);
          textFinalized = false;
        }
        currentMsg.events!.push(event);
        this.cb?.onStreamEvent(this.id, currentMsg, event);
      }
    };

    agent.session.on("event", eventHandler);
    this.cb?.onAgentBusy?.(this.id, agent.info.id);

    let prompt = cleanContent;
    if (images?.length) {
      const refs = images.map((img) => img.path).join("\n");
      prompt = `[User attached image(s). Use the Read tool to view:\n${refs}]\n\n${prompt || "Please look at the attached image(s)."}`;
    }

    try {
      await agent.session.send(prompt);
      if (!textFinalized) currentMsg.status = "done";
    } catch {
      if (textFinalized) {
        currentMsg = makeAgentMsg();
        currentMsg.status = "error";
        this.messages.push(currentMsg);
        this.cb?.onNewMessage(this.id, currentMsg);
      } else {
        currentMsg.status = "error";
      }
    } finally {
      agent.session.off("event", eventHandler);
      this.cb?.onAgentIdle?.(this.id, agent.info.id);
      if (!textFinalized) {
        this.cb?.onMessageDone(this.id, currentMsg.id, currentMsg.status, currentMsg.content);
      }
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

  getGitBranch(): string | null {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
    } catch {
      return null;
    }
  }

  getInfo(includeMessages = true): WorkspaceInfo {
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      cwd: this.cwd,
      gitBranch: this.getGitBranch(),
      agents: [...this.agents.values()].map((a) => ({
        ...a.info,
        busy: a.session.isRunning,
      })),
      messages: includeMessages ? this.messages : [],
      createdAt: this.createdAt,
    };
  }

  getMessages(): Message[] {
    return this.messages;
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
      messages: this.messages,
      createdAt: this.createdAt,
    };
  }

  static fromState(state: WorkspaceState, cb?: WorkspaceCallbacks): Workspace {
    const ws = new Workspace(state.id, state.name, state.project, state.cwd, cb);
    ws.createdAt = state.createdAt;
    ws.messages = state.messages.map((m) => ({
      ...m,
      kind: m.kind ?? (m.agentId === null ? "user" : "agent"),
      status: m.status === "streaming" ? "done" : m.status,
    }));

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
