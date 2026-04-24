import { WebSocketServer, WebSocket } from "ws";
import { Workspace, WorkspaceCallbacks } from "./task";
import { StreamEvent } from "./session";
import { saveState, loadState, appendLog } from "./state";
import { loadConfig, AppConfig } from "./config";
import { AGENT_PRESETS, MODEL_OPTIONS } from "./presets";

export class Server {
  private wss: WebSocketServer;
  private workspaces = new Map<string, Workspace>();
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

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private onConnect(ws: WebSocket): void {
    this.clients.add(ws);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(ws, msg);
      } catch (e) {
        this.send(ws, { type: "error", message: `Invalid message: ${e}` });
      }
    });

    ws.on("close", () => this.clients.delete(ws));

    this.send(ws, {
      type: "init",
      workspaces: [...this.workspaces.values()].map((w) => w.getInfo()),
      config: {
        projects: this.config.projects,
        presets: AGENT_PRESETS,
        models: MODEL_OPTIONS,
      },
    });
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "create_workspace":
        this.createWorkspace(ws, msg.name as string, msg.project as string);
        break;

      case "delete_workspace":
        this.deleteWorkspace(msg.workspaceId as string);
        break;

      case "add_agent":
        this.addAgent(
          ws,
          msg.workspaceId as string,
          msg.name as string,
          msg.model as string,
          msg.avatar as string,
          msg.color as string,
          msg.permissionMode as string | undefined,
        );
        break;

      case "remove_agent":
        this.removeAgent(msg.workspaceId as string, msg.agentId as string);
        break;

      case "send_message":
        this.sendMessage(msg.workspaceId as string, msg.content as string, msg.target as string | undefined);
        break;

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        break;

      default:
        this.send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  }

  private createWorkspace(ws: WebSocket, name: string, project: string): void {
    const cwd = this.config.projects[project];
    if (!cwd) {
      this.send(ws, { type: "error", message: `Unknown project: ${project}` });
      return;
    }

    const id = genId("ws");
    const workspace = new Workspace(id, name, project, cwd, this.makeCallbacks());

    this.workspaces.set(id, workspace);
    this.persistState();
    this.broadcast({ type: "workspace_created", workspace: workspace.getInfo() });
  }

  private deleteWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    ws.abortAll();
    this.workspaces.delete(workspaceId);
    this.persistState();
    this.broadcast({ type: "workspace_deleted", workspaceId });
  }

  private addAgent(
    ws: WebSocket,
    workspaceId: string,
    name: string,
    model: string,
    avatar: string,
    color: string,
    permissionMode?: string,
  ): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.send(ws, { type: "error", message: "Workspace not found" });
      return;
    }

    const agent = workspace.addAgent(name, model, avatar, color, {
      permissionMode: permissionMode ?? "bypassPermissions",
    });
    this.persistState();
    this.broadcast({ type: "agent_added", workspaceId, agent });
  }

  private removeAgent(workspaceId: string, agentId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    workspace.removeAgent(agentId);
    this.persistState();
    this.broadcast({ type: "agent_removed", workspaceId, agentId });
  }

  private async sendMessage(workspaceId: string, content: string, target?: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.broadcast({ type: "error", message: "Workspace not found" });
      return;
    }

    try {
      await workspace.sendMessage(content, target);
    } catch (e) {
      this.broadcast({
        type: "error",
        message: `${e instanceof Error ? e.message : e}`,
      });
    }

    this.persistState();
  }

  private abortAgent(workspaceId: string, agentId?: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    if (agentId) {
      workspace.abortAgent(agentId);
    } else {
      workspace.abortAll();
    }
  }

  private persistState(): void {
    const workspaces = [...this.workspaces.values()].map((w) => w.getState());
    saveState(this.baseDir, { workspaces });
  }

  private restoreState(): void {
    const state = loadState(this.baseDir);
    if (!state) return;

    for (const wsState of state.workspaces) {
      const workspace = Workspace.fromState(wsState, this.makeCallbacks());
      this.workspaces.set(workspace.id, workspace);
    }

    console.log(`Restored ${this.workspaces.size} workspace(s)`);
  }

  private makeCallbacks(): WorkspaceCallbacks {
    return {
      onNewMessage: (wsId, msg) => {
        this.broadcast({ type: "new_message", workspaceId: wsId, message: msg });
      },
      onStreamEvent: (wsId, agentMsg, event) => {
        appendLog(this.baseDir, wsId, { timestamp: Date.now(), messageId: agentMsg.id, event });
        this.broadcast({ type: "stream_event", workspaceId: wsId, messageId: agentMsg.id, event });
      },
      onMessageDone: (wsId, msgId, status, content) => {
        this.broadcast({ type: "message_done", workspaceId: wsId, messageId: msgId, status, content });
        this.persistState();
      },
    };
  }

  close(): void {
    this.persistState();
    for (const ws of this.workspaces.values()) ws.abortAll();
    this.wss.close();
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();

const server = new Server(port, baseDir);

process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
