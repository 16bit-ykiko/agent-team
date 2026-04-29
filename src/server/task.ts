import { execSync, exec } from "child_process";
import {
  SessionConfig,
  StreamEvent,
  SessionState,
  shellQuote,
  DISTRO_PATH_PREFIX,
  getWslBin,
} from "./session";
import { HostSessionHandle, HostRegistry } from "./host";

export type MessageStatus = "streaming" | "done" | "error";
export type MessageKind = "user" | "agent" | "system";

export interface MessageImage {
  name: string;
  url: string;
}

export interface ForwardRef {
  messageId: string;
  fromAgent: string;
  fromAvatar: string;
  preview: string;
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
  forwardRef?: ForwardRef;
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
  hostId: string;
  cwd: string;
  gitBranch: string | null;
  prUrl: string | null;
  prTitle: string | null;
  agents: AgentInfo[];
  messages: Message[];
  createdAt: number;
  lastMessageAt?: number;
}

export interface WorkspaceState {
  id: string;
  name: string;
  project: string;
  hostId: string;
  cwd: string;
  agents: AgentState[];
  messages: Message[];
  createdAt: number;
}

export interface AgentEntry {
  info: AgentInfo;
  session: HostSessionHandle;
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
  hostId: string;
  cwd: string;
  agents = new Map<string, AgentEntry>();
  messages: Message[] = [];
  createdAt: number;
  cachedPrUrl: string | null = null;
  cachedPrTitle: string | null = null;

  private cb?: WorkspaceCallbacks;
  private hostRegistry: HostRegistry;

  constructor(
    id: string,
    name: string,
    project: string,
    hostId: string,
    cwd: string,
    hostRegistry: HostRegistry,
    cb?: WorkspaceCallbacks,
  ) {
    this.id = id;
    this.name = name;
    this.project = project;
    this.hostId = hostId;
    this.cwd = cwd;
    this.hostRegistry = hostRegistry;
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
    const host = this.hostRegistry.get(this.hostId);
    if (!host) throw new Error(`Host not found: ${this.hostId}`);
    if (!host.connected) throw new Error(`Host not connected: ${this.hostId}`);

    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isDefault = this.agents.size === 0;

    const info: AgentInfo = { id, name, model, avatar, color, isDefault };
    const session = host.createSession(id, { cwd: this.cwd, model, ...config });

    this.agents.set(id, { info, session });
    this.pushSystemMessage(`${avatar} **${name}** joined the team`);
    return info;
  }

  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    const host = this.hostRegistry.get(this.hostId);
    if (host) host.destroySession(agentId);
    else entry.session.abort();
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
    quote?: { messageId: string; agentId: string | null; content: string },
  ): Promise<void> {
    let resolvedTarget = target;
    let cleanContent = content;
    const mentionMatch = content.match(/(?:^|\s)@(\S+)/);
    if (mentionMatch) {
      if (!resolvedTarget) resolvedTarget = mentionMatch[1];
      cleanContent = content.replace(/(?:^|\s)@\S+\s*/, " ").trim();
    }

    const agent = this.resolveAgent(resolvedTarget);
    if (!agent)
      throw new Error(resolvedTarget ? `Agent not found: ${resolvedTarget}` : "No default agent");
    if (agent.session.isRunning) throw new Error(`Agent ${agent.info.name} is busy`);

    const msgImages = images?.map(({ name, url }) => ({ name, url }));

    let forwardRef: ForwardRef | undefined;
    if (quote) {
      const fromEntry = quote.agentId
        ? [...this.agents.values()].find((a) => a.info.id === quote.agentId)
        : null;
      const preview = quote.content.slice(0, 120) + (quote.content.length > 120 ? "..." : "");
      forwardRef = {
        messageId: quote.messageId,
        fromAgent: fromEntry?.info.name ?? "User",
        fromAvatar: fromEntry?.info.avatar ?? "👤",
        preview,
      };
    }

    const userMsg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content,
      timestamp: Date.now(),
      status: "done",
      images: msgImages?.length ? msgImages : undefined,
      forwardRef,
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
    if (quote) {
      const quotedFrom = forwardRef?.fromAgent ?? "Unknown";
      prompt = `[Quoted from ${quotedFrom}]:\n${quote.content}\n\n${prompt}`;
    }
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

  async forwardMessage(messageId: string, targetAgentId: string): Promise<void> {
    const original = this.messages.find((m) => m.id === messageId);
    if (!original || !original.content) throw new Error("Message not found");

    const fromAgent = original.agentId
      ? [...this.agents.values()].find((a) => a.info.id === original.agentId)
      : null;

    const agent = this.resolveAgent(targetAgentId);
    if (!agent) throw new Error("Target agent not found");
    if (agent.session.isRunning) throw new Error(`Agent ${agent.info.name} is busy`);

    const preview = original.content.slice(0, 120) + (original.content.length > 120 ? "..." : "");
    const forwardRef: ForwardRef = {
      messageId,
      fromAgent: fromAgent?.info.name ?? "User",
      fromAvatar: fromAgent?.info.avatar ?? "👤",
      preview,
    };

    const userMsg: Message = {
      id: genId("msg"),
      kind: "user",
      agentId: null,
      content: "",
      timestamp: Date.now(),
      status: "done",
      forwardRef,
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

    const prompt = `[Forwarded message from ${fromAgent?.info.name ?? "User"}]:\n\n${original.content}`;

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

  private getHostDistro(): string | undefined {
    return this.hostRegistry.get(this.hostId)?.distro;
  }

  private wslExec(cmd: string): string {
    const distro = this.getHostDistro();
    if (distro) {
      const inner = `export PATH="${DISTRO_PATH_PREFIX}:$PATH" && cd ${shellQuote(this.cwd)} && ${cmd}`;
      return execSync(`${getWslBin()} -d ${distro} -- bash -c ${shellQuote(inner)} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
    }
    return execSync(cmd, { cwd: this.cwd, encoding: "utf-8", timeout: 5000 }).trim();
  }

  private wslExecAsync(cmd: string): Promise<string | null> {
    const distro = this.getHostDistro();
    if (distro) {
      const inner = `export PATH="${DISTRO_PATH_PREFIX}:$PATH" && cd ${shellQuote(this.cwd)} && ${cmd}`;
      const fullCmd = `${getWslBin()} -d ${distro} -- bash -c ${shellQuote(inner)} 2>/dev/null`;
      return new Promise((resolve) => {
        exec(fullCmd, { encoding: "utf-8", timeout: 15000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim() || null);
        });
      });
    }
    return new Promise((resolve) => {
      exec(cmd, { cwd: this.cwd, encoding: "utf-8", timeout: 10000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }

  getGitBranch(): string | null {
    try {
      return this.wslExec("git rev-parse --abbrev-ref HEAD");
    } catch {
      return null;
    }
  }

  getPrInfo(branch: string | null): Promise<{ url: string; title: string } | null> {
    if (!branch || branch === "main" || branch === "master") return Promise.resolve(null);
    return this.wslExecAsync(`gh pr view ${shellQuote(branch)} --json url,title 2>/dev/null`).then(
      (stdout) => {
        if (!stdout) return null;
        try {
          const data = JSON.parse(stdout);
          return data.url ? { url: data.url, title: data.title || "" } : null;
        } catch {
          return null;
        }
      },
    );
  }

  getInfo(includeMessages = true): WorkspaceInfo {
    const lastMsg = this.messages[this.messages.length - 1];
    return {
      id: this.id,
      name: this.name,
      project: this.project,
      hostId: this.hostId,
      cwd: this.cwd,
      gitBranch: this.getGitBranch(),
      prUrl: this.cachedPrUrl,
      prTitle: this.cachedPrTitle,
      agents: [...this.agents.values()].map((a) => ({
        ...a.info,
        busy: a.session.isRunning,
      })),
      messages: includeMessages ? this.messages : [],
      createdAt: this.createdAt,
      lastMessageAt: lastMsg?.timestamp ?? this.createdAt,
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
      hostId: this.hostId,
      cwd: this.cwd,
      agents: [...this.agents.values()].map((a) => ({
        ...a.info,
        session: a.session.getState(),
      })),
      messages: this.messages,
      createdAt: this.createdAt,
    };
  }

  static fromState(
    state: WorkspaceState,
    hostRegistry: HostRegistry,
    cb?: WorkspaceCallbacks,
  ): Workspace {
    const hostId = state.hostId || "local";
    const ws = new Workspace(
      state.id,
      state.name,
      state.project,
      hostId,
      state.cwd,
      hostRegistry,
      cb,
    );
    ws.createdAt = state.createdAt;
    ws.messages = state.messages.map((m) => ({
      ...m,
      kind: m.kind ?? (m.agentId === null ? "user" : "agent"),
      status: m.status === "streaming" ? "done" : m.status,
    }));

    const host = hostRegistry.get(hostId) ?? hostRegistry.getDefault()!;
    for (const agentState of state.agents) {
      const session = host.restoreSession(agentState.id, agentState.session);
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
