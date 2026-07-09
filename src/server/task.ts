import { execSync } from "child_process";
import {
  SessionConfig,
  StreamEvent,
  SessionState,
  CommandInfo,
} from "./session";
import { HostSessionHandle, HostRegistry } from "./host";
import { effortLevelsForModel } from "./presets";

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
  handler: (event: StreamEvent) => void;
  currentMsg: Message | null;
}

export interface WorkspaceCallbacks {
  onNewMessage: (wsId: string, msg: Message) => void;
  onStreamEvent: (wsId: string, msg: Message, event: StreamEvent) => void;
  onMessageDone: (wsId: string, msgId: string, status: MessageStatus, content: string, events?: StreamEvent[]) => void;
  onAgentBusy?: (wsId: string, agentId: string) => void;
  onAgentIdle?: (wsId: string, agentId: string) => void;
  onCommandsChanged?: (wsId: string, commands: CommandInfo[]) => void;
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

  private makeAgentMsg(agentId: string): Message {
    return {
      id: genId("msg"),
      kind: "agent",
      agentId,
      content: "",
      timestamp: Date.now(),
      status: "streaming",
      events: [],
      turnId: genId("turn"),
    };
  }

  private ensureAgentMsg(entry: AgentEntry): Message {
    if (!entry.currentMsg) {
      entry.currentMsg = this.makeAgentMsg(entry.info.id);
      this.messages.push(entry.currentMsg);
      this.cb?.onNewMessage(this.id, entry.currentMsg);
    }
    return entry.currentMsg;
  }

  // Process subagent progress/done on a specific message (may differ from currentMsg
  // when events arrive after the originating message was finalized by a result event).
  private handleSubagentOnMsg(msg: Message, event: StreamEvent): void {
    if (!msg.events) msg.events = [];
    const taskId = event.subagent?.taskId;

    if (event.kind === "subagent_progress") {
      const innerEvent = event.subagent?._innerEvent;
      const startIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );

      if (innerEvent && startIdx >= 0) {
        const saEvents = msg.events[startIdx].subagent!.events ??= [];
        if (innerEvent.kind === "tool_result" && innerEvent.toolUseId) {
          const i = saEvents.findIndex((e) => e.kind === "tool_use" && e.toolUseId === innerEvent.toolUseId);
          if (i >= 0) { saEvents[i].toolResult = innerEvent.content; this.cb?.onStreamEvent(this.id, msg, event); return; }
        }
        if (innerEvent.kind === "subagent_progress" && innerEvent.subagent?.taskId) {
          const i = saEvents.findIndex((e) => e.kind === "subagent_progress" && e.subagent?.taskId === innerEvent.subagent?.taskId);
          if (i >= 0) { saEvents[i] = innerEvent; this.cb?.onStreamEvent(this.id, msg, event); return; }
        }
        if (innerEvent.kind === "subagent_done" && innerEvent.subagent?.taskId) {
          const nid = innerEvent.subagent.taskId;
          const pi = saEvents.findIndex((e) => e.kind === "subagent_progress" && e.subagent?.taskId === nid);
          if (pi >= 0) saEvents.splice(pi, 1);
          const si = saEvents.findIndex((e) => e.kind === "subagent_start" && e.subagent?.taskId === nid);
          if (si >= 0) { saEvents[si].subagent!.status = innerEvent.subagent.status; saEvents[si].subagent!.summary = innerEvent.subagent.summary; saEvents[si].subagent!.usage = innerEvent.subagent.usage; }
        }
        saEvents.push(innerEvent);
        this.cb?.onStreamEvent(this.id, msg, event);
        return;
      }
      delete event.subagent?._innerEvent;

      if (startIdx >= 0) event.contentOffset = msg.events[startIdx].contentOffset;
      const prev = msg.events.findIndex((e) => e.kind === "subagent_progress" && e.subagent?.taskId === taskId);
      if (prev >= 0) msg.events[prev] = event;
      else msg.events.push(event);
    } else if (event.kind === "subagent_done") {
      const startIdx = msg.events.findIndex(
        (e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId,
      );
      if (startIdx >= 0) {
        event.contentOffset = msg.events[startIdx].contentOffset;
        msg.events[startIdx].subagent!.status = event.subagent?.status;
        msg.events[startIdx].subagent!.summary = event.subagent?.summary;
        msg.events[startIdx].subagent!.usage = event.subagent?.usage;
      }
      const progIdx = msg.events.findIndex((e) => e.kind === "subagent_progress" && e.subagent?.taskId === taskId);
      if (progIdx >= 0) msg.events.splice(progIdx, 1);
      msg.events.push(event);
    }
    this.cb?.onStreamEvent(this.id, msg, event);
  }

  // Subagent events can arrive after the message containing subagent_start is
  // finalized. Search backwards to find the message that owns this subagent.
  private findSubagentOwner(taskId: string): Message | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.events?.some((e) => e.kind === "subagent_start" && e.subagent?.taskId === taskId)) {
        return m;
      }
    }
    return null;
  }

  private createEventHandler(agentId: string): (event: StreamEvent) => void {
    return (event: StreamEvent) => {
      const entry = this.agents.get(agentId);
      if (!entry) return;

      // Route subagent events to the message containing their subagent_start,
      // even if that message was already finalized. This prevents orphaned
      // subagent entries from appearing in a new message bubble.
      if (event.kind === "subagent_progress" || event.kind === "subagent_done") {
        const taskId = event.subagent?.taskId;
        if (taskId) {
          const ownerMsg = this.findSubagentOwner(taskId);
          if (ownerMsg && ownerMsg !== entry.currentMsg) {
            this.handleSubagentOnMsg(ownerMsg, event);
            return;
          }
        }
      }

      if (!entry.currentMsg && event.kind !== "result" && event.kind !== "error" && event.kind !== "compact") {
        this.cb?.onAgentBusy?.(this.id, agentId);
      }

      if (event.kind === "text_delta") {
        const msg = this.ensureAgentMsg(entry);
        msg.content += event.content;
        this.cb?.onStreamEvent(this.id, msg, event);
      } else if (event.kind === "thinking_delta") {
        const msg = this.ensureAgentMsg(entry);
        this.cb?.onStreamEvent(this.id, msg, event);
      } else if (event.kind === "text") {
        // text comes via text_delta streaming; finalized text event is redundant
      } else if (event.kind === "result") {
        if (entry.currentMsg) {
          entry.currentMsg.status = "done";
          this.cb?.onMessageDone(
            this.id,
            entry.currentMsg.id,
            "done",
            entry.currentMsg.content,
            entry.currentMsg.events,
          );
        }
        entry.currentMsg = null;
        this.cb?.onAgentIdle?.(this.id, agentId);
      } else if (event.kind === "error") {
        const msg = this.ensureAgentMsg(entry);
        msg.status = "error";
        if (!msg.content) {
          msg.content = event.content;
        } else {
          msg.content += "\n\n" + event.content;
        }
        msg.events!.push(event);
        this.cb?.onStreamEvent(this.id, msg, event);
        this.cb?.onMessageDone(this.id, msg.id, "error", msg.content, msg.events);
        entry.currentMsg = null;
        this.cb?.onAgentIdle?.(this.id, agentId);
      } else if (event.kind === "subagent_progress" || event.kind === "subagent_done") {
        const msg = this.ensureAgentMsg(entry);
        this.handleSubagentOnMsg(msg, event);
      } else if (event.kind === "tool_result" && event.toolUseId) {
        const msg = this.ensureAgentMsg(entry);
        const matchIdx = msg.events!.findIndex(
          (e) => e.kind === "tool_use" && e.toolUseId === event.toolUseId,
        );
        if (matchIdx >= 0) {
          msg.events![matchIdx].toolResult = event.content;
          if (event.isMarkdown) msg.events![matchIdx].toolResultIsMarkdown = true;
        } else {
          event.contentOffset = msg.content.length;
          msg.events!.push(event);
        }
        this.cb?.onStreamEvent(this.id, msg, event);
      } else {
        const msg = this.ensureAgentMsg(entry);
        event.contentOffset = msg.content.length;
        msg.events!.push(event);
        this.cb?.onStreamEvent(this.id, msg, event);
      }
    };
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
    const handler = this.createEventHandler(id);

    session.on("event", handler);
    session.on("commands", (cmds: CommandInfo[]) => {
      this.cb?.onCommandsChanged?.(this.id, cmds);
    });

    this.agents.set(id, { info, session, handler, currentMsg: null });
    this.pushSystemMessage(`${avatar} **${name}** joined the team`);
    return info;
  }

  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    entry.session.off("event", entry.handler);

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
    const first = this.agents.values().next();
    return first.done ? null : first.value;
  }

  private async tryHandleCommand(text: string, agent: AgentEntry): Promise<string | null> {
    if (text === "/usage" || text === "/cost") {
      const data = await agent.session.getUsageInfo?.();
      if (!data) return "No active session — send a message first to start a session.";
      return formatUsageInfo(data);
    }
    if (text === "/context") {
      const data = await agent.session.getContextUsage?.();
      if (!data) return "No active session — send a message first to start a session.";
      return formatContextUsage(data);
    }
    if (text === "/effort" || text.startsWith("/effort ")) {
      return this.handleEffortCommand(text.slice("/effort".length).trim(), agent);
    }
    return null;
  }

  private handleEffortCommand(arg: string, agent: AgentEntry): string {
    const model = agent.info.model;
    const levels = effortLevelsForModel(model);
    if (levels.length === 0) {
      return `**${agent.info.name}** (${model}) does not support effort levels.`;
    }

    const current = agent.session.getState().config.effort;
    const levelList = levels.map((l) => (l === current ? `**${l}**` : `\`${l}\``)).join(" · ");

    if (!arg) {
      return [
        `**${agent.info.name}** (${model})`,
        `Effort: ${current ?? "*(default)*"}`,
        `Available: ${levelList}`,
        "",
        "Use `/effort <level>` to change it.",
      ].join("\n");
    }

    const level = arg.toLowerCase();
    if (!levels.includes(level)) {
      return `Invalid effort level \`${arg}\` for ${model}. Available: ${levelList}`;
    }
    if (level === current) {
      return `Effort for **${agent.info.name}** is already **${level}**.`;
    }
    if (!agent.session.setEffort) {
      return `**${agent.info.name}** does not support changing the effort level.`;
    }

    agent.session.setEffort(level);
    return `Effort for **${agent.info.name}** set to **${level}**${current ? ` (was ${current})` : ""}. Applies from the next message.`;
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

    const cmdResult = await this.tryHandleCommand(cleanContent.trim(), agent);
    if (cmdResult !== null) {
      const userMsg: Message = {
        id: genId("msg"),
        kind: "user",
        agentId: null,
        content,
        timestamp: Date.now(),
        status: "done",
      };
      this.messages.push(userMsg);
      this.cb?.onNewMessage(this.id, userMsg);

      const agentMsg = this.makeAgentMsg(agent.info.id);
      agentMsg.content = cmdResult;
      agentMsg.status = "done";
      this.messages.push(agentMsg);
      this.cb?.onNewMessage(this.id, agentMsg);
      this.cb?.onMessageDone(this.id, agentMsg.id, "done", cmdResult);
      return;
    }

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

    this.cb?.onAgentBusy?.(this.id, agent.info.id);

    agent.currentMsg = this.makeAgentMsg(agent.info.id);
    this.messages.push(agent.currentMsg);
    this.cb?.onNewMessage(this.id, agent.currentMsg);

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
    } catch (err) {
      console.error("[sendMessage]", err);
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

    this.cb?.onAgentBusy?.(this.id, agent.info.id);

    agent.currentMsg = this.makeAgentMsg(agent.info.id);
    this.messages.push(agent.currentMsg);
    this.cb?.onNewMessage(this.id, agent.currentMsg);

    const prompt = `[Forwarded message from ${fromAgent?.info.name ?? "User"}]:\n\n${original.content}`;

    try {
      await agent.session.send(prompt);
    } catch (err) {
      console.error("[forwardMessage]", err);
    }
  }

  abortAgent(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    entry.session.abort();
    this.finalizeAbort(entry);
  }

  abortAll(): void {
    for (const entry of this.agents.values()) {
      entry.session.abort();
      this.finalizeAbort(entry);
    }
  }

  private finalizeAbort(entry: AgentEntry): void {
    if (entry.currentMsg && entry.currentMsg.status === "streaming") {
      if (entry.currentMsg.content) {
        entry.currentMsg.content += "\n\n*\\[interrupted\\]*";
      } else {
        entry.currentMsg.content = "*\\[interrupted\\]*";
      }
      entry.currentMsg.status = "done";
      this.cb?.onMessageDone(
        this.id,
        entry.currentMsg.id,
        "done",
        entry.currentMsg.content,
        entry.currentMsg.events,
      );
    }
    entry.currentMsg = null;
    this.cb?.onAgentIdle?.(this.id, entry.info.id);
  }

  clearContext(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (entry.session.isRunning) return false;
    entry.session.abort();
    entry.session.sessionId = null;
    entry.session.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turns: 0,
      duration_ms: 0,
    };
    entry.currentMsg = null;
    this.pushSystemMessage(`${entry.info.avatar} **${entry.info.name}** context cleared`);
    return true;
  }

  getGitBranch(): string | null {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: this.cwd, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  }

  getPrInfo(branch: string | null): Promise<{ url: string; title: string } | null> {
    if (!branch || branch === "main" || branch === "master") return Promise.resolve(null);
    // Use execFile to avoid shell injection — branch names go as direct args.
    const { execFile } = require("child_process");
    return new Promise<string | null>((resolve) => {
      execFile("gh", ["pr", "view", branch, "--json", "url,title"],
        { cwd: this.cwd, encoding: "utf-8", timeout: 10000 },
        (err: Error | null, stdout: string) => resolve(err ? null : stdout.trim() || null),
      );
    }).then(
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
    ws.messages = state.messages.map((m) => {
      const msg = {
        ...m,
        kind: m.kind ?? (m.agentId === null ? "user" : "agent"),
        status: m.status === "streaming" ? ("done" as MessageStatus) : m.status,
      };
      if (msg.events) {
        for (const ev of msg.events) {
          if (ev.subagent?.status === "running") {
            ev.subagent.status = "stopped";
          }
        }
      }
      return msg;
    });

    const host = hostRegistry.get(hostId) ?? hostRegistry.getDefault()!;
    for (const agentState of state.agents) {
      const session = host.restoreSession(agentState.id, agentState.session);
      const handler = ws.createEventHandler(agentState.id);
      session.on("event", handler);
      session.on("commands", (cmds: CommandInfo[]) => {
        ws.cb?.onCommandsChanged?.(ws.id, cmds);
      });
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
        handler,
        currentMsg: null,
      });
    }

    return ws;
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatUsageInfo(data: Record<string, unknown>): string {
  const lines: string[] = ["## Session Usage"];

  const session = data.session as Record<string, unknown> | undefined;
  if (session) {
    const cost = session.total_cost_usd as number | undefined;
    if (cost != null) lines.push(`**Session cost:** $${cost.toFixed(4)}`);
    const dur = session.total_duration_ms as number | undefined;
    if (dur != null) lines.push(`**Duration:** ${Math.round(dur / 1000)}s`);
    const added = session.total_lines_added as number | undefined;
    const removed = session.total_lines_removed as number | undefined;
    if (added != null || removed != null)
      lines.push(`**Lines:** +${added ?? 0} / -${removed ?? 0}`);
  }

  const sub = data.subscription_type as string | undefined;
  if (sub) lines.push(`**Plan:** ${sub}`);

  const rl = data.rate_limits as Record<string, unknown> | undefined;
  if (rl) {
    lines.push("", "### Rate Limits");
    for (const key of ["five_hour", "seven_day"] as const) {
      const w = rl[key] as Record<string, unknown> | undefined;
      if (!w) continue;
      const util = w.utilization as number;
      const resets = w.resets_at as string | undefined;
      const label = key === "five_hour" ? "5-hour" : "7-day";
      const bar = renderBar(util);
      const resetStr = resets ? ` (resets ${new Date(resets).toLocaleTimeString()})` : "";
      lines.push(`**${label}:** ${bar} ${util.toFixed(1)}%${resetStr}`);
    }
  }

  return lines.join("\n");
}

function formatContextUsage(data: Record<string, unknown>): string {
  const total = data.totalTokens as number | undefined;
  const max = data.maxTokens as number | undefined;
  const pct = data.percentage as number | undefined;
  const model = data.model as string | undefined;
  const categories = data.categories as Array<Record<string, unknown>> | undefined;

  const lines: string[] = ["## Context Usage"];
  if (model) lines.push(`**Model:** ${model}`);
  if (total != null && max != null) {
    const bar = renderBar(pct ?? (total / max) * 100);
    lines.push(
      `**Tokens:** ${(total / 1000).toFixed(1)}k / ${(max / 1000).toFixed(1)}k ${bar} ${(pct ?? 0).toFixed(1)}%`,
    );
  }

  if (categories?.length) {
    lines.push("", "| Category | Tokens | % |", "|---|---:|---:|");
    for (const c of categories) {
      const name = c.name as string;
      const tokens = c.tokens as number;
      const share = max ? ((tokens / max) * 100).toFixed(1) : "—";
      lines.push(`| ${name} | ${(tokens / 1000).toFixed(1)}k | ${share}% |`);
    }
  }

  const api = data.apiUsage as Record<string, number> | undefined;
  if (api) {
    lines.push("", "### API Usage (this session)");
    lines.push(`- **Input:** ${(api.input_tokens / 1000).toFixed(1)}k`);
    lines.push(`- **Output:** ${(api.output_tokens / 1000).toFixed(1)}k`);
    if (api.cache_read_input_tokens)
      lines.push(`- **Cache read:** ${(api.cache_read_input_tokens / 1000).toFixed(1)}k`);
    if (api.cache_creation_input_tokens)
      lines.push(`- **Cache write:** ${(api.cache_creation_input_tokens / 1000).toFixed(1)}k`);
  }

  return lines.join("\n");
}

function renderBar(pct: number): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
  return "█".repeat(filled) + "░".repeat(20 - filled);
}
