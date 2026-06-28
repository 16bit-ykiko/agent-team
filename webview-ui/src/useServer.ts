import { useState, useEffect, useRef, useCallback } from "react";
import {
  MOCK_WORKSPACES,
  MOCK_SYSTEM_STATUS,
  MOCK_PRESETS,
  MOCK_MODELS,
  MOCK_PROJECTS,
} from "./mockData";

export interface ToolInput {
  tool: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export interface SubAgentInfo {
  taskId: string;
  description: string;
  prompt?: string;
  agentType?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  lastTool?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  summary?: string;
  events?: StreamEvent[];
}

export interface StreamEvent {
  kind: string;
  content: string;
  toolInput?: ToolInput;
  step?: number;
  contentOffset?: number;
  toolUseId?: string;
  isMarkdown?: boolean;
  toolResult?: string;
  toolResultIsMarkdown?: boolean;
  subagent?: SubAgentInfo;
}

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
  kind: "user" | "agent" | "system";
  agentId: string | null;
  content: string;
  timestamp: number;
  status: "streaming" | "done" | "error";
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
  busy?: boolean;
}

export interface HostInfo {
  id: string;
  label: string;
  type: "local" | "remote";
  connected: boolean;
}

export interface HostConfig {
  label: string;
  type: "local" | "remote";
}

export interface Workspace {
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
  hasMore?: boolean;
  messagesLoaded?: boolean;
}

export interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

export interface QuotaEntry {
  label: string;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  fetchedAt: number;
}

export interface SystemStatus {
  osName: string;
  osArch: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsage: number;
  memTotal: number;
  memUsed: number;
  uptime: number;
  hostname: string;
  quota: QuotaEntry[];
}

export interface AgentPreset {
  name: string;
  avatar: string;
  color: string;
}

export interface ModelOption {
  id: string;
  label: string;
  backend: "claude" | "codex";
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

function resolveWsUrl(): string {
  const loc = window.location;
  if (loc.port === "5173" || loc.port === "9800") {
    return `ws://${loc.hostname}:9800`;
  }
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${loc.pathname}`;
}

export function useServer() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [connected, setConnected] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [projects, setProjects] = useState<Record<string, Record<string, string>>>({});
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [hostConfigs, setHostConfigs] = useState<Record<string, HostConfig>>({});
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const pendingEventsRef = useRef<Array<{ wsId: string; messageId: string; event: StreamEvent }>>(
    [],
  );
  const rafRef = useRef<number>(0);

  const flushStreamEvents = useCallback(() => {
    rafRef.current = 0;
    const batch = pendingEventsRef.current;
    if (batch.length === 0) return;
    pendingEventsRef.current = [];
    setWorkspaces((prev) =>
      prev.map((w) => {
        const relevant = batch.filter((e) => e.wsId === w.id);
        if (relevant.length === 0) return w;
        return {
          ...w,
          messages: w.messages.map((m) => {
            const evts = relevant.filter((e) => e.messageId === m.id);
            if (evts.length === 0) return m;
            const deltas = evts.filter(
              (e) => e.event.kind === "text_delta" || e.event.kind === "thinking_delta",
            );
            const regular = evts.filter(
              (e) => e.event.kind !== "text_delta" && e.event.kind !== "thinking_delta",
            );
            let content = m.content;
            if (deltas.length > 0) {
              const textDelta = deltas
                .filter((e) => e.event.kind === "text_delta")
                .map((e) => e.event.content)
                .join("");
              if (textDelta) content = (content || "") + textDelta;
            }
            if (regular.length === 0 && deltas.length > 0) {
              return { ...m, content };
            }
            let events = [...(m.events ?? []).map((e) =>
              e.subagent ? { ...e, subagent: { ...e.subagent, events: e.subagent.events ? [...e.subagent.events] : undefined } } : e,
            )];
            for (const r of regular) {
              const ev = r.event;
              if (ev.kind === "tool_result" && ev.toolUseId) {
                const matchIdx = events.findIndex(
                  (e) => e.kind === "tool_use" && e.toolUseId === ev.toolUseId,
                );
                if (matchIdx >= 0) {
                  events[matchIdx] = { ...events[matchIdx], toolResult: ev.content, ...(ev.isMarkdown && { toolResultIsMarkdown: true }) };
                  continue;
                }
              }
              if (ev.kind === "subagent_progress" && ev.subagent?.taskId) {
                const innerEv = (ev.subagent as Record<string, unknown>)?._innerEvent as StreamEvent | undefined;
                if (innerEv) {
                  const startIdx = events.findIndex(
                    (e) => e.kind === "subagent_start" && e.subagent?.taskId === ev.subagent?.taskId,
                  );
                  if (startIdx >= 0) {
                    const sa = events[startIdx].subagent!;
                    if (!sa.events) sa.events = [];
                    if (innerEv.kind === "tool_result" && innerEv.toolUseId) {
                      const innerMatchIdx = sa.events.findIndex(
                        (e) => e.kind === "tool_use" && e.toolUseId === innerEv.toolUseId,
                      );
                      if (innerMatchIdx >= 0) {
                        sa.events[innerMatchIdx] = { ...sa.events[innerMatchIdx], toolResult: innerEv.content };
                      } else {
                        sa.events.push(innerEv);
                      }
                    } else {
                      sa.events.push(innerEv);
                    }
                  }
                  continue;
                }
                const idx = events.findIndex(
                  (e) => e.kind === "subagent_progress" && e.subagent?.taskId === ev.subagent?.taskId,
                );
                if (idx >= 0) { events[idx] = ev; continue; }
              } else if (ev.kind === "subagent_done" && ev.subagent?.taskId) {
                events = events.filter(
                  (e) => !(e.kind === "subagent_progress" && e.subagent?.taskId === ev.subagent?.taskId),
                );
                const startIdx = events.findIndex(
                  (e) => e.kind === "subagent_start" && e.subagent?.taskId === ev.subagent?.taskId,
                );
                if (startIdx >= 0 && ev.subagent) {
                  const existingEvents = events[startIdx].subagent?.events;
                  events[startIdx] = { ...events[startIdx], subagent: { ...events[startIdx].subagent!, ...ev.subagent, events: existingEvents } };
                }
              }
              events.push(ev);
            }
            return { ...m, content, events };
          }),
        };
      }),
    );
  }, []);

  const handleServerMessage = useCallback(
    (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "init": {
          const incoming = msg.workspaces as Workspace[];
          setWorkspaces((prev) => {
            if (prev.length === 0) return incoming;
            const prevMap = new Map(prev.map((w) => [w.id, w]));
            return incoming.map((w) => {
              const existing = prevMap.get(w.id);
              if (existing?.messagesLoaded) {
                return {
                  ...w,
                  messages: existing.messages,
                  messagesLoaded: true,
                  hasMore: existing.hasMore,
                };
              }
              return w;
            });
          });
          const config = msg.config as {
            projects: Record<string, Record<string, string>>;
            presets: AgentPreset[];
            models: ModelOption[];
            commands: CommandInfo[];
            hosts: Record<string, HostConfig>;
          };
          setProjects(config.projects);
          setPresets(config.presets);
          setModels(config.models);
          if (config.commands) setCommands(config.commands);
          if (config.hosts) setHostConfigs(config.hosts);
          if (msg.hosts) setHosts(msg.hosts as HostInfo[]);
          setHostAvailable(Boolean(msg.hostAvailable));
          break;
        }

        case "host_state":
          setHostAvailable(Boolean(msg.available));
          break;

        case "hosts_update":
          setHosts(msg.hosts as HostInfo[]);
          break;

        case "commands_update":
          setCommands(msg.commands as CommandInfo[]);
          break;

        case "workspace_messages": {
          const wsId = msg.workspaceId as string;
          const incoming = msg.messages as Message[];
          const hasMore = msg.hasMore as boolean;
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              if (!w.messagesLoaded) {
                return { ...w, messages: incoming, hasMore, messagesLoaded: true };
              }
              const existingIds = new Set(w.messages.map((m) => m.id));
              const newMsgs = incoming.filter((m) => !existingIds.has(m.id));
              return { ...w, messages: [...newMsgs, ...w.messages], hasMore };
            }),
          );
          break;
        }

        case "workspace_created":
          setWorkspaces((prev) => [...prev, msg.workspace as Workspace]);
          break;

        case "workspace_deleted":
          setWorkspaces((prev) => prev.filter((w) => w.id !== msg.workspaceId));
          break;

        case "agent_added": {
          const wsId = msg.workspaceId as string;
          const agent = msg.agent as AgentInfo;
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === wsId ? { ...w, agents: [...w.agents, agent] } : w)),
          );
          break;
        }

        case "agent_removed": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId ? { ...w, agents: w.agents.filter((a) => a.id !== agentId) } : w,
            ),
          );
          break;
        }

        case "new_message": {
          const wsId = msg.workspaceId as string;
          const message = msg.message as Message;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? { ...w, messages: [...w.messages, message], lastMessageAt: message.timestamp }
                : w,
            ),
          );
          break;
        }

        case "stream_event": {
          pendingEventsRef.current.push({
            wsId: msg.workspaceId as string,
            messageId: msg.messageId as string,
            event: msg.event as StreamEvent,
          });
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(flushStreamEvents);
          }
          break;
        }

        case "message_done": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          const status = msg.status as Message["status"];
          const content = msg.content as string;
          const events = msg.events as StreamEvent[] | undefined;
          pendingEventsRef.current = pendingEventsRef.current.filter(
            (e) => !(e.wsId === wsId && e.messageId === messageId),
          );
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              return {
                ...w,
                messages: w.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, status, content, ...(events ? { events } : {}) }
                    : m,
                ),
              };
            }),
          );
          break;
        }

        case "agent_busy": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) => (a.id === agentId ? { ...a, busy: true } : a)),
                  }
                : w,
            ),
          );
          break;
        }

        case "agent_idle": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) => (a.id === agentId ? { ...a, busy: false } : a)),
                  }
                : w,
            ),
          );
          break;
        }

        case "workspace_branch_update": {
          const wsId = msg.workspaceId as string;
          const gitBranch = msg.gitBranch as string | null;
          const prUrl = (msg.prUrl as string | null) ?? null;
          const prTitle = (msg.prTitle as string | null) ?? null;
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === wsId ? { ...w, gitBranch, prUrl, prTitle } : w)),
          );
          break;
        }

        case "system_status":
          setSystemStatus({
            osName: msg.osName as string,
            osArch: msg.osArch as string,
            cpuModel: msg.cpuModel as string,
            cpuCores: msg.cpuCores as number,
            cpuUsage: msg.cpuUsage as number,
            memTotal: msg.memTotal as number,
            memUsed: msg.memUsed as number,
            uptime: msg.uptime as number,
            hostname: msg.hostname as string,
            quota: (msg.quota as QuotaEntry[]) ?? [],
          });
          break;

        case "error":
          console.error("[server]", msg.message);
          break;
      }
    },
    [flushStreamEvents],
  );

  const connect = useCallback(() => {
    const ws = new WebSocket(resolveWsUrl());
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectRef.current = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
  }, [handleServerMessage]);

  const useMock = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

  useEffect(() => {
    if (useMock) {
      setWorkspaces(MOCK_WORKSPACES);
      setPresets(MOCK_PRESETS);
      setModels(MOCK_MODELS);
      setProjects(MOCK_PROJECTS);
      setSystemStatus(MOCK_SYSTEM_STATUS);
      setConnected(true);
      return;
    }
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect, useMock]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return {
    workspaces,
    connected,
    hostAvailable,
    presets,
    models,
    projects,
    commands,
    hosts,
    hostConfigs,
    systemStatus,
    callHostAction: useCallback(
      (action: string, args: unknown) => send({ type: "host_action", action, args }),
      [send],
    ),
    loadMessages: useCallback(
      (wsId: string, before?: number) =>
        send({ type: "load_messages", workspaceId: wsId, before, limit: 50 }),
      [send],
    ),
    createWorkspace: useCallback(
      (name: string, project: string, hostId?: string, customPath?: string) =>
        send({ type: "create_workspace", name, project, hostId, customPath }),
      [send],
    ),
    deleteWorkspace: useCallback(
      (id: string) => send({ type: "delete_workspace", workspaceId: id }),
      [send],
    ),
    addAgent: useCallback(
      (wsId: string, name: string, model: string, avatar: string, color: string) =>
        send({ type: "add_agent", workspaceId: wsId, name, model, avatar, color }),
      [send],
    ),
    removeAgent: useCallback(
      (wsId: string, agentId: string) => send({ type: "remove_agent", workspaceId: wsId, agentId }),
      [send],
    ),
    sendMessage: useCallback(
      (
        wsId: string,
        content: string,
        target?: string,
        images?: Array<{ name: string; url: string }>,
        quote?: { messageId: string; agentId: string | null; content: string },
      ) => send({ type: "send_message", workspaceId: wsId, content, target, images, quote }),
      [send],
    ),
    forwardMessage: useCallback(
      (wsId: string, messageId: string, targetAgentId: string) =>
        send({ type: "forward_message", workspaceId: wsId, messageId, targetAgentId }),
      [send],
    ),
    abort: useCallback(
      (wsId: string, agentId?: string) => send({ type: "abort", workspaceId: wsId, agentId }),
      [send],
    ),
    clearContext: useCallback(
      (wsId: string, agentId: string) =>
        send({ type: "clear_context", workspaceId: wsId, agentId }),
      [send],
    ),
    openDiff: useCallback(
      (filePath: string, oldString: string, newString: string) =>
        send({ type: "open_diff", filePath, oldString, newString }),
      [send],
    ),
    restartServer: useCallback(() => send({ type: "restart_server" }), [send]),
  };
}
