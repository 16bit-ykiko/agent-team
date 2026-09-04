import { useState, useEffect, useRef, useCallback } from "react";
import { MOCK_WORKSPACES, MOCK_SYSTEM_STATUS, MOCK_PRESETS, MOCK_MODELS } from "./mockData";
import { applyStreamBatch, PendingEvent } from "./stream";

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
  eventCount?: number;
  events?: StreamEvent[];
}

export type NoticeLevel = "info" | "notice" | "warning" | "error" | "wakeup";

export interface ContextUsage {
  tokens: number;
  window: number;
}

export interface StreamEvent {
  kind: string;
  content: string;
  toolName?: string;
  level?: NoticeLevel;
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
  status: "streaming" | "done" | "error" | "queued";
  events?: StreamEvent[];
  turnId?: string;
  images?: MessageImage[];
  forwardRef?: ForwardRef;
  queuedFor?: string;
  effort?: string;
  context?: ContextUsage;
}

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  avatar: string;
  color: string;
  isDefault: boolean;
  busy?: boolean;
  // Transient label of what the agent is doing (compacting, a long tool...).
  activity?: string | null;
  // Current reasoning effort level, when the model supports one.
  effort?: string | null;
  account?: string;
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
  archivedAt?: number | null;
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

export interface SearchHit {
  workspaceId: string;
  workspaceName: string;
  messageId: string;
  timestamp: number;
  snippet: string;
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
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [defaultAccount, setDefaultAccountState] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [hostConfigs, setHostConfigs] = useState<Record<string, HostConfig>>({});
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [archiveAfterDays, setArchiveAfterDays] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<{ query: string; hits: SearchHit[] }>({
    query: "",
    hits: [],
  });
  const [dirSuggestions, setDirSuggestions] = useState<{ prefix: string; dirs: string[] }>({
    prefix: "",
    dirs: [],
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const pendingEventsRef = useRef<PendingEvent[]>([]);
  const rafRef = useRef<number>(0);

  const flushStreamEvents = useCallback(() => {
    rafRef.current = 0;
    const batch = pendingEventsRef.current;
    if (batch.length === 0) return;
    pendingEventsRef.current = [];
    setWorkspaces((prev) => applyStreamBatch(prev, batch));
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
            presets: AgentPreset[];
            models: ModelOption[];
            commands: CommandInfo[];
            hosts: Record<string, HostConfig>;
          };
          setPresets(config.presets);
          setModels(config.models);
          const cfgExtra = config as unknown as {
            accounts?: string[];
            defaultAccount?: string | null;
            archiveAfterDays?: number;
          };
          setAccounts(cfgExtra.accounts ?? []);
          setDefaultAccountState(cfgExtra.defaultAccount ?? null);
          setArchiveAfterDays(cfgExtra.archiveAfterDays ?? 0);
          if (config.commands) setCommands(config.commands);
          if (config.hosts) setHostConfigs(config.hosts);
          if (msg.hosts) setHosts(msg.hosts as HostInfo[]);
          break;
        }

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

        case "agent_updated": {
          const wsId = msg.workspaceId as string;
          const agent = msg.agent as AgentInfo;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) => (a.id === agent.id ? { ...a, ...agent } : a)),
                  }
                : w,
            ),
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
          const context = msg.context as ContextUsage | undefined;
          pendingEventsRef.current = pendingEventsRef.current.filter(
            (e) => !(e.wsId === wsId && e.messageId === messageId),
          );
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              return {
                ...w,
                messages: w.messages.map((m) => {
                  if (m.id !== messageId) return m;
                  let merged = events;
                  if (events && m.events) {
                    merged = events.map((serverEv) => {
                      if (!serverEv.subagent?.taskId) return serverEv;
                      const clientEv = m.events!.find(
                        (e) => e.subagent?.taskId === serverEv.subagent!.taskId,
                      );
                      if (clientEv?.subagent?.events?.length) {
                        return {
                          ...serverEv,
                          subagent: { ...serverEv.subagent, events: clientEv.subagent.events },
                        };
                      }
                      return serverEv;
                    });
                  }
                  return {
                    ...m,
                    status,
                    content,
                    ...(merged ? { events: merged } : {}),
                    ...(context ? { context } : {}),
                  };
                }),
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

        case "agent_activity": {
          const wsId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          const activity = (msg.activity as string | null) ?? null;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? {
                    ...w,
                    agents: w.agents.map((a) => (a.id === agentId ? { ...a, activity } : a)),
                  }
                : w,
            ),
          );
          break;
        }

        case "workspace_archived": {
          const wsId = msg.workspaceId as string;
          const archivedAt = msg.archivedAt as number;
          // The server dropped the history; forget ours so reopening reloads.
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId
                ? { ...w, archivedAt, messages: [], messagesLoaded: false, hasMore: false }
                : w,
            ),
          );
          break;
        }

        case "workspace_unarchived": {
          const wsId = msg.workspaceId as string;
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === wsId ? { ...w, archivedAt: null } : w)),
          );
          break;
        }

        case "subagent_events": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          const taskId = msg.taskId as string;
          const saEvents = msg.events as StreamEvent[];
          setWorkspaces((prev) =>
            prev.map((w) => {
              if (w.id !== wsId) return w;
              return {
                ...w,
                messages: w.messages.map((m) => {
                  if (m.id !== messageId || !m.events) return m;
                  return {
                    ...m,
                    events: m.events.map((e) => {
                      if (e.subagent?.taskId !== taskId) return e;
                      return { ...e, subagent: { ...e.subagent, events: saEvents } };
                    }),
                  };
                }),
              };
            }),
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

        case "message_removed": {
          const wsId = msg.workspaceId as string;
          const messageId = msg.messageId as string;
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === wsId ? { ...w, messages: w.messages.filter((m) => m.id !== messageId) } : w,
            ),
          );
          break;
        }

        case "config_update":
          setAccounts((msg.accounts as string[]) ?? []);
          setDefaultAccountState((msg.defaultAccount as string | null) ?? null);
          break;

        case "default_account":
          setDefaultAccountState((msg.account as string | null) ?? null);
          break;

        case "search_results":
          setSearchResults({ query: msg.query as string, hits: msg.hits as SearchHit[] });
          break;

        case "dirs":
          setDirSuggestions({ prefix: msg.prefix as string, dirs: msg.dirs as string[] });
          break;

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
          setLastError(String(msg.message));
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
  const useReplay =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("replay");

  useEffect(() => {
    if (useMock) {
      setWorkspaces(MOCK_WORKSPACES);
      setPresets(MOCK_PRESETS);
      setModels(MOCK_MODELS);
      setSystemStatus(MOCK_SYSTEM_STATUS);
      setConnected(true);
      return;
    }
    if (useReplay) {
      setConnected(true);
      import("./replay").then(({ startReplay }) =>
        startReplay(handleServerMessage).catch((e) => console.error("[replay]", e)),
      );
      return;
    }
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect, useMock, useReplay, handleServerMessage]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return {
    workspaces,
    connected,
    presets,
    models,
    commands,
    hosts,
    hostConfigs,
    systemStatus,
    archiveAfterDays,
    lastError,
    clearError: useCallback(() => setLastError(null), []),
    loadMessages: useCallback(
      (wsId: string, before?: number) =>
        send({ type: "load_messages", workspaceId: wsId, before, limit: 50 }),
      [send],
    ),
    loadSubagentEvents: useCallback(
      (wsId: string, messageId: string, taskId: string) =>
        send({ type: "load_subagent_events", workspaceId: wsId, messageId, taskId }),
      [send],
    ),
    cancelSubagent: useCallback(
      (wsId: string, agentId: string, taskId: string) => {
        if (wsId === "replay-demo") {
          // Demo workspace exists only client-side; emulate the stop locally.
          import("./replayFixture").then(({ cancelDemoSubagent }) =>
            cancelDemoSubagent(handleServerMessage, taskId),
          );
          return;
        }
        send({ type: "cancel_subagent", workspaceId: wsId, agentId, taskId });
      },
      [send, handleServerMessage],
    ),
    // Plays the synthetic rendering-review fixture through the same dispatch
    // path as live server frames. Returns the demo workspace id.
    startReplayDemo: useCallback(() => {
      import("./replayFixture").then(({ startDemoReplay }) =>
        startDemoReplay(handleServerMessage).catch((e) => console.error("[replay-demo]", e)),
      );
      return "replay-demo";
    }, [handleServerMessage]),
    createWorkspace: useCallback(
      (name: string, path: string, hostId?: string) =>
        send({ type: "create_workspace", name, path, hostId }),
      [send],
    ),
    cancelQueued: useCallback(
      (wsId: string, messageId: string) =>
        send({ type: "cancel_queued", workspaceId: wsId, messageId }),
      [send],
    ),
    searchServer: useCallback((query: string) => send({ type: "search", query }), [send]),
    searchResults,
    listDirs: useCallback((prefix: string) => send({ type: "list_dirs", prefix }), [send]),
    dirSuggestions,
    deleteWorkspace: useCallback(
      (id: string) => send({ type: "delete_workspace", workspaceId: id }),
      [send],
    ),
    addAgent: useCallback(
      (
        wsId: string,
        name: string,
        model: string,
        avatar: string,
        color: string,
        account?: string,
      ) => send({ type: "add_agent", workspaceId: wsId, name, model, avatar, color, account }),
      [send],
    ),
    accounts,
    defaultAccount,
    setDefaultAccount: useCallback(
      (account: string | null) => send({ type: "set_default_account", account }),
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
    restartServer: useCallback(() => send({ type: "restart_server" }), [send]),
    archiveWorkspace: useCallback(
      (wsId: string) => send({ type: "archive_workspace", workspaceId: wsId }),
      [send],
    ),
    unarchiveWorkspace: useCallback(
      (wsId: string) => send({ type: "unarchive_workspace", workspaceId: wsId }),
      [send],
    ),
    purgeArchived: useCallback(() => send({ type: "purge_archived" }), [send]),
  };
}
