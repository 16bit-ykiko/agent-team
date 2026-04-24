import { WebSocketServer, WebSocket } from "ws";
import { Task, Message, TaskInfo } from "./task";
import { StreamEvent, SessionConfig } from "./session";
import { saveState, loadState } from "./state";
import { loadConfig, AppConfig } from "./config";
import * as path from "path";

type ClientMessage =
  | { type: "list_tasks" }
  | { type: "create_task"; name: string; project: string }
  | { type: "send_message"; taskId: string; content: string; role?: string }
  | { type: "abort"; taskId: string; role?: string }
  | { type: "get_config" }
  | { type: "delete_task"; taskId: string };

type ServerMessage =
  | { type: "tasks"; tasks: TaskInfo[] }
  | { type: "task_created"; task: TaskInfo }
  | { type: "task_deleted"; taskId: string }
  | { type: "message"; taskId: string; message: Message }
  | { type: "stream_event"; taskId: string; messageId: string; event: StreamEvent }
  | { type: "task_status"; taskId: string; status: string }
  | { type: "config"; config: { projects: Record<string, string>; agents: string[] } }
  | { type: "error"; message: string };

export class Server {
  private wss: WebSocketServer;
  private tasks = new Map<string, Task>();
  private clients = new Set<WebSocket>();
  private config: AppConfig;
  private baseDir: string;

  constructor(port: number, baseDir: string) {
    this.baseDir = baseDir;
    this.config = loadConfig(baseDir);

    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.onConnect(ws));

    this.restoreState();

    console.log(`Agent Team server listening on ws://localhost:${port}`);
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private onConnect(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        this.handleMessage(ws, msg);
      } catch (e) {
        this.send(ws, { type: "error", message: `Invalid message: ${e}` });
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    this.send(ws, {
      type: "tasks",
      tasks: [...this.tasks.values()].map((t) => t.getInfo()),
    });
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case "list_tasks":
        this.send(ws, {
          type: "tasks",
          tasks: [...this.tasks.values()].map((t) => t.getInfo()),
        });
        break;

      case "create_task":
        this.createTask(ws, msg.name, msg.project);
        break;

      case "send_message":
        this.sendMessage(msg.taskId, msg.content, msg.role ?? "planner");
        break;

      case "abort":
        this.abortTask(msg.taskId, msg.role);
        break;

      case "get_config":
        this.send(ws, {
          type: "config",
          config: {
            projects: this.config.projects,
            agents: Object.keys(this.config.agents),
          },
        });
        break;

      case "delete_task":
        this.deleteTask(msg.taskId);
        break;

      default:
        this.send(ws, { type: "error", message: "Unknown message type" });
    }
  }

  private createTask(ws: WebSocket, name: string, project: string): void {
    const cwd = this.config.projects[project];
    if (!cwd) {
      this.send(ws, { type: "error", message: `Unknown project: ${project}` });
      return;
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentConfigs = this.buildAgentConfigs(cwd);

    const task = new Task(id, name, project, cwd, agentConfigs, (taskId, msg, event) => {
      this.broadcast({
        type: "stream_event",
        taskId,
        messageId: msg.id,
        event,
      });
    });

    this.tasks.set(id, task);
    this.persistState();

    this.broadcast({ type: "task_created", task: task.getInfo() });
  }

  private async sendMessage(taskId: string, content: string, role: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.broadcast({ type: "error", message: `Task not found: ${taskId}` });
      return;
    }

    const userMsg: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content,
      timestamp: Date.now(),
    };

    this.broadcast({ type: "message", taskId, message: userMsg });
    this.broadcast({ type: "task_status", taskId, status: "running" });

    try {
      const agentMsg = await task.sendToAgent(role, content, userMsg);
      this.broadcast({ type: "message", taskId, message: agentMsg });
    } finally {
      this.broadcast({ type: "task_status", taskId, status: task.status });
      this.persistState();
    }
  }

  private abortTask(taskId: string, role?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (role) {
      task.abortAgent(role);
    } else {
      task.abortAll();
    }
  }

  private deleteTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.abortAll();
    this.tasks.delete(taskId);
    this.persistState();
    this.broadcast({ type: "task_deleted", taskId });
  }

  private buildAgentConfigs(cwd: string): Record<string, SessionConfig> {
    const configs: Record<string, SessionConfig> = {};
    for (const [role, agent] of Object.entries(this.config.agents)) {
      configs[role] = {
        cwd,
        model: agent.model || undefined,
        effort: agent.effort || undefined,
        permissionMode: agent.permission_mode || undefined,
      };
    }
    return configs;
  }

  private persistState(): void {
    const tasks = [...this.tasks.values()].map((t) => t.getState());
    saveState(this.baseDir, { tasks });
  }

  private restoreState(): void {
    const state = loadState(this.baseDir);
    if (!state) return;

    for (const taskState of state.tasks) {
      const task = Task.fromState(taskState, (taskId, msg, event) => {
        this.broadcast({
          type: "stream_event",
          taskId,
          messageId: msg.id,
          event,
        });
      });
      this.tasks.set(task.id, task);
    }

    console.log(`Restored ${this.tasks.size} task(s) from state`);
  }

  close(): void {
    this.persistState();
    for (const task of this.tasks.values()) {
      task.abortAll();
    }
    this.wss.close();
  }
}

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();

const server = new Server(port, baseDir);

process.on("SIGINT", () => {
  console.log("Shutting down...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
