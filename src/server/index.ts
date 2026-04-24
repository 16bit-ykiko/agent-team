import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { Workspace, WorkspaceCallbacks } from "./task";
import { saveState, loadState, appendLog } from "./state";
import { loadConfig, AppConfig } from "./config";
import { AGENT_PRESETS, MODEL_OPTIONS } from "./presets";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export class Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private workspaces = new Map<string, Workspace>();
  private uiClients = new Set<WebSocket>();
  private hostClient: WebSocket | null = null;
  private config: AppConfig;
  private baseDir: string;
  private webDir: string;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private prevCpuIdle = 0;
  private prevCpuTotal = 0;

  constructor(port: number, baseDir: string, webDir: string) {
    this.baseDir = baseDir;
    this.webDir = webDir;
    this.config = loadConfig(baseDir);

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.onConnect(ws));

    this.restoreState();
    this.initCpuBaseline();
    this.statusTimer = setInterval(() => this.broadcastSystemStatus(), 3000);

    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(`Agent Team server listening on http://0.0.0.0:${port}`);
    });
  }

  private initCpuBaseline(): void {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    this.prevCpuIdle = idle;
    this.prevCpuTotal = total;
  }

  private getSystemStatus(): Record<string, unknown> {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    const idleDelta = idle - this.prevCpuIdle;
    const totalDelta = total - this.prevCpuTotal;
    const cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    this.prevCpuIdle = idle;
    this.prevCpuTotal = total;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      type: "system_status",
      osName: `${os.type()} ${os.release()}`,
      osArch: os.arch(),
      cpuModel: cpus[0]?.model ?? "Unknown",
      cpuCores: cpus.length,
      cpuUsage,
      memTotal: totalMem,
      memUsed: totalMem - freeMem,
      uptime: os.uptime(),
      hostname: os.hostname(),
    };
  }

  private broadcastSystemStatus(): void {
    if (this.uiClients.size === 0) return;
    this.broadcastUI(this.getSystemStatus());
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      const target = path.normalize(path.join(this.webDir, pathname));
      if (!target.startsWith(this.webDir + path.sep) && target !== this.webDir) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const ext = path.extname(target);
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  }

  private sendJson(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastUI(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.uiClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private onConnect(ws: WebSocket): void {
    this.uiClients.add(ws);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(ws, msg);
      } catch (e) {
        this.sendJson(ws, { type: "error", message: `Invalid message: ${e}` });
      }
    });

    ws.on("close", () => {
      this.uiClients.delete(ws);
      if (this.hostClient === ws) {
        this.hostClient = null;
        this.broadcastUI({ type: "host_state", available: false });
      }
    });

    this.sendJson(ws, {
      type: "init",
      workspaces: [...this.workspaces.values()].map((w) => w.getInfo()),
      config: {
        projects: this.config.projects,
        presets: AGENT_PRESETS,
        models: MODEL_OPTIONS,
      },
      hostAvailable: this.hostClient !== null,
    });
    this.sendJson(ws, this.getSystemStatus());
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "register_host":
        if (this.hostClient && this.hostClient !== ws) {
          this.hostClient.close(1000, "replaced by new host");
        }
        this.hostClient = ws;
        this.uiClients.delete(ws);
        this.broadcastUI({ type: "host_state", available: true });
        return;

      case "host_action":
        if (this.hostClient) {
          this.sendJson(this.hostClient, {
            type: "host_action",
            action: msg.action,
            args: msg.args,
          });
        }
        return;

      case "create_workspace":
        this.createWorkspace(ws, msg.name as string, msg.project as string);
        return;

      case "delete_workspace":
        this.deleteWorkspace(msg.workspaceId as string);
        return;

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
        return;

      case "remove_agent":
        this.removeAgent(msg.workspaceId as string, msg.agentId as string);
        return;

      case "send_message":
        this.sendMessage(
          msg.workspaceId as string,
          msg.content as string,
          msg.target as string | undefined,
        );
        return;

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        return;

      default:
        this.sendJson(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  }

  private createWorkspace(ws: WebSocket, name: string, project: string): void {
    const cwd = this.config.projects[project];
    if (!cwd) {
      this.sendJson(ws, { type: "error", message: `Unknown project: ${project}` });
      return;
    }

    const id = genId("ws");
    const workspace = new Workspace(id, name, project, cwd, this.makeCallbacks());

    this.workspaces.set(id, workspace);
    this.persistState();
    this.broadcastUI({ type: "workspace_created", workspace: workspace.getInfo() });
  }

  private deleteWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    ws.abortAll();
    this.workspaces.delete(workspaceId);
    this.persistState();
    this.broadcastUI({ type: "workspace_deleted", workspaceId });
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
      this.sendJson(ws, { type: "error", message: "Workspace not found" });
      return;
    }

    const agent = workspace.addAgent(name, model, avatar, color, {
      permissionMode: permissionMode ?? "bypassPermissions",
    });
    this.persistState();
    this.broadcastUI({ type: "agent_added", workspaceId, agent });
  }

  private removeAgent(workspaceId: string, agentId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    workspace.removeAgent(agentId);
    this.persistState();
    this.broadcastUI({ type: "agent_removed", workspaceId, agentId });
  }

  private async sendMessage(workspaceId: string, content: string, target?: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.broadcastUI({ type: "error", message: "Workspace not found" });
      return;
    }

    try {
      await workspace.sendMessage(content, target);
    } catch (e) {
      this.broadcastUI({
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
        this.broadcastUI({ type: "new_message", workspaceId: wsId, message: msg });
      },
      onStreamEvent: (wsId, agentMsg, event) => {
        appendLog(this.baseDir, wsId, { timestamp: Date.now(), messageId: agentMsg.id, event });
        this.broadcastUI({
          type: "stream_event",
          workspaceId: wsId,
          messageId: agentMsg.id,
          event,
        });
      },
      onMessageDone: (wsId, msgId, status, content) => {
        this.broadcastUI({
          type: "message_done",
          workspaceId: wsId,
          messageId: msgId,
          status,
          content,
        });
        this.persistState();
      },
    };
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.persistState();
    for (const ws of this.workspaces.values()) ws.abortAll();
    this.wss.close();
    this.httpServer.close();
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();
const webDir = process.env.AGENT_TEAM_WEB_DIR ?? path.join(__dirname, "webview");

const server = new Server(port, baseDir, webDir);

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
