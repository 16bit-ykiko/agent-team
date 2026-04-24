import { useState, useEffect, useRef, useCallback } from "react";

export interface StreamEvent {
  kind: string;
  content: string;
}

export interface Message {
  id: string;
  role: "user" | "planner" | "coder" | "reviewer" | "validator" | "system";
  content: string;
  timestamp: number;
  events?: StreamEvent[];
}

export interface Task {
  id: string;
  name: string;
  project: string;
  cwd: string;
  status: "idle" | "running" | "done" | "failed";
  messages: Message[];
}

declare const window: Window & { __AGENT_TEAM_PORT__?: number };

export function useServer() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    const port = window.__AGENT_TEAM_PORT__ ?? 9800;
    const ws = new WebSocket(`ws://localhost:${port}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "get_config" }));
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleServerMessage(msg);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const handleServerMessage = useCallback((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "tasks":
        setTasks(msg.tasks as Task[]);
        break;

      case "task_created":
        setTasks((prev) => [...prev, msg.task as Task]);
        break;

      case "task_deleted":
        setTasks((prev) => prev.filter((t) => t.id !== msg.taskId));
        break;

      case "message": {
        const taskId = msg.taskId as string;
        const message = msg.message as Message;
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId
              ? { ...t, messages: [...t.messages, message] }
              : t,
          ),
        );
        break;
      }

      case "stream_event": {
        const taskId = msg.taskId as string;
        const messageId = msg.messageId as string;
        const event = msg.event as StreamEvent;
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t;
            return {
              ...t,
              messages: t.messages.map((m) => {
                if (m.id !== messageId) return m;
                const updated = { ...m, events: [...(m.events ?? []), event] };
                if (event.kind === "text" || event.kind === "result") {
                  updated.content = (m.content ?? "") + event.content;
                }
                return updated;
              }),
            };
          }),
        );
        break;
      }

      case "task_status": {
        const taskId = msg.taskId as string;
        const status = msg.status as Task["status"];
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, status } : t)),
        );
        break;
      }

      case "config": {
        const config = msg.config as { projects: Record<string, string> };
        setProjects(Object.keys(config.projects));
        break;
      }

      case "error":
        console.error("[server]", msg.message);
        break;
    }
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const createTask = useCallback(
    (name: string, project: string) => {
      send({ type: "create_task", name, project });
    },
    [send],
  );

  const sendMessage = useCallback(
    (taskId: string, content: string, role?: string) => {
      send({ type: "send_message", taskId, content, role });
    },
    [send],
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      send({ type: "delete_task", taskId });
    },
    [send],
  );

  return { tasks, connected, projects, createTask, sendMessage, deleteTask };
}
