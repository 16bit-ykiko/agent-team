import { useState, useEffect, useRef, useCallback } from "react";

export interface StreamEvent {
  kind: string;
  content: string;
}

export interface Message {
  id: string;
  kind: "user" | "agent" | "system";
  agentId: string | null;
  content: string;
  timestamp: number;
  status: "streaming" | "done" | "error";
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

export interface Workspace {
  id: string;
  name: string;
  project: string;
  cwd: string;
  gitBranch: string | null;
  agents: AgentInfo[];
  messages: Message[];
  createdAt: number;
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
}

export interface AgentPreset {
  name: string;
  avatar: string;
  color: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

const SERVER_PORT = 9800;

function resolveWsUrl(): string {
  const host = window.location.hostname || "localhost";
  return `ws://${host}:${SERVER_PORT}`;
}

export function useServer() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [connected, setConnected] = useState(false);
  const [hostAvailable, setHostAvailable] = useState(false);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();

  const handleServerMessage = useCallback((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "init": {
        setWorkspaces(msg.workspaces as Workspace[]);
        const config = msg.config as {
          projects: Record<string, string>;
          presets: AgentPreset[];
          models: ModelOption[];
        };
        setProjects(Object.keys(config.projects));
        setPresets(config.presets);
        setModels(config.models);
        setHostAvailable(Boolean(msg.hostAvailable));
        break;
      }

      case "host_state":
        setHostAvailable(Boolean(msg.available));
        break;

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
          prev.map((w) => (w.id === wsId ? { ...w, messages: [...w.messages, message] } : w)),
        );
        break;
      }

      case "stream_event": {
        const wsId = msg.workspaceId as string;
        const messageId = msg.messageId as string;
        const event = msg.event as StreamEvent;
        setWorkspaces((prev) =>
          prev.map((w) => {
            if (w.id !== wsId) return w;
            return {
              ...w,
              messages: w.messages.map((m) => {
                if (m.id !== messageId) return m;
                const events = [...(m.events ?? []), event];
                const content = event.kind === "text" ? event.content : m.content;
                return { ...m, events, content };
              }),
            };
          }),
        );
        break;
      }

      case "message_done": {
        const wsId = msg.workspaceId as string;
        const messageId = msg.messageId as string;
        const status = msg.status as Message["status"];
        const content = msg.content as string;
        setWorkspaces((prev) =>
          prev.map((w) => {
            if (w.id !== wsId) return w;
            return {
              ...w,
              messages: w.messages.map((m) => (m.id === messageId ? { ...m, status, content } : m)),
            };
          }),
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
        });
        break;

      case "error":
        console.error("[server]", msg.message);
        break;
    }
  }, []);

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

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

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
    systemStatus,
    callHostAction: useCallback(
      (action: string, args: unknown) => send({ type: "host_action", action, args }),
      [send],
    ),
    createWorkspace: useCallback(
      (name: string, project: string) => send({ type: "create_workspace", name, project }),
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
      (wsId: string, content: string, target?: string) =>
        send({ type: "send_message", workspaceId: wsId, content, target }),
      [send],
    ),
    abort: useCallback(
      (wsId: string, agentId?: string) => send({ type: "abort", workspaceId: wsId, agentId }),
      [send],
    ),
  };
}
