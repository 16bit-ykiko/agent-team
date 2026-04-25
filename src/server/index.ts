import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { exec, execSync, spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { Workspace, WorkspaceCallbacks } from "./task";
import { saveWorkspace, deleteWorkspaceState, saveIndex, loadAll, appendLog } from "./state";
import { loadConfig, AppConfig } from "./config";
import { AGENT_PRESETS, MODEL_OPTIONS } from "./presets";
import { loadSkills, SkillDef } from "./skills";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
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
  private readonly isWSL: boolean;
  private windowsHost: { memTotal: number; memFree: number; osName: string } | null = null;
  private windowsHostUpdating = false;
  private skills: SkillDef[] = [];
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private uploadsDir: string;

  constructor(port: number, baseDir: string, webDir: string) {
    this.baseDir = baseDir;
    this.webDir = webDir;
    this.uploadsDir = path.join(baseDir, "uploads");
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.config = loadConfig(baseDir);
    this.skills = loadSkills(baseDir);
    this.isWSL = this.detectWSL();

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.onConnect(ws));

    this.restoreState();
    this.initCpuBaseline();
    if (this.isWSL) this.refreshWindowsHost();
    this.statusTimer = setInterval(() => this.broadcastSystemStatus(), 3000);

    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(`Agent Team server listening on http://0.0.0.0:${port}`);
      if (this.isWSL) console.log("WSL detected — reporting Windows host memory");
    });
  }

  private detectWSL(): boolean {
    try {
      return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf-8"));
    } catch {
      return false;
    }
  }

  private refreshWindowsHost(): void {
    if (this.windowsHostUpdating) return;
    this.windowsHostUpdating = true;
    exec(
      "wmic.exe OS get Caption,FreePhysicalMemory,TotalVisibleMemorySize /value",
      { encoding: "utf-8", timeout: 8000 },
      (err, stdout) => {
        this.windowsHostUpdating = false;
        if (err || !stdout) return;
        const totalKB = parseInt(stdout.match(/TotalVisibleMemorySize=(\d+)/)?.[1] ?? "0");
        const freeKB = parseInt(stdout.match(/FreePhysicalMemory=(\d+)/)?.[1] ?? "0");
        const caption = stdout.match(/Caption=(.+)/)?.[1]?.trim() ?? "Windows";
        if (totalKB > 0) {
          this.windowsHost = { memTotal: totalKB * 1024, memFree: freeKB * 1024, osName: caption };
        }
      },
    );
  }

  private initCpuBaseline(): void {
    const cpus = os.cpus();
    let idle = 0,
      total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    this.prevCpuIdle = idle;
    this.prevCpuTotal = total;
  }

  private getSystemStatus(): Record<string, unknown> {
    const cpus = os.cpus();
    let idle = 0,
      total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    const idleDelta = idle - this.prevCpuIdle;
    const totalDelta = total - this.prevCpuTotal;
    const cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    this.prevCpuIdle = idle;
    this.prevCpuTotal = total;

    const wh = this.windowsHost;
    const memTotal = wh ? wh.memTotal : os.totalmem();
    const memUsed = wh ? wh.memTotal - wh.memFree : os.totalmem() - os.freemem();
    const osName = wh ? wh.osName : `${os.type()} ${os.release()}`;

    if (this.isWSL) this.refreshWindowsHost();

    return {
      type: "system_status",
      osName,
      osArch: os.arch(),
      cpuModel: cpus[0]?.model ?? "Unknown",
      cpuCores: cpus.length,
      cpuUsage,
      memTotal,
      memUsed,
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
      const pathname = decodeURIComponent(url.pathname);

      if (req.method === "POST" && pathname === "/upload") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const rawName = (req.headers["x-filename"] as string) || "image.jpg";
          const ext = path.extname(rawName) || ".jpg";
          const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
          const filePath = path.join(this.uploadsDir, filename);
          fs.writeFileSync(filePath, buffer);
          console.log(`[upload] saved ${rawName} → ${filename} (${buffer.length} bytes)`);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(JSON.stringify({ url: `uploads/${filename}`, name: rawName }));
        });
        return;
      }

      if (pathname.startsWith("/uploads/")) {
        const target = path.normalize(
          path.join(this.uploadsDir, pathname.slice("/uploads/".length)),
        );
        if (!target.startsWith(this.uploadsDir + path.sep) && target !== this.uploadsDir) {
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
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(target).pipe(res);
        return;
      }

      let filePath = pathname;
      if (filePath === "/") filePath = "/index.html";
      const target = path.normalize(path.join(this.webDir, filePath));
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
      workspaces: [...this.workspaces.values()].map((w) => w.getInfo(false)),
      config: {
        projects: this.config.projects,
        presets: AGENT_PRESETS,
        models: MODEL_OPTIONS,
        skills: this.skills,
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

      case "load_messages": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace) {
          const before = (msg.before as number) ?? Infinity;
          const limit = Math.min((msg.limit as number) ?? 50, 200);
          const all = workspace.getMessages();
          const filtered = before === Infinity ? all : all.filter((m) => m.timestamp < before);
          const page = filtered.slice(-limit);
          this.sendJson(ws, {
            type: "workspace_messages",
            workspaceId: workspace.id,
            messages: page,
            hasMore: filtered.length > limit,
          });
        }
        return;
      }

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

      case "send_message": {
        const rawImages = msg.images as Array<{ name: string; url: string }> | undefined;
        const images = rawImages?.length
          ? rawImages.map((img) => ({
              name: img.name,
              url: img.url,
              path: path.join(this.uploadsDir, path.basename(img.url)),
            }))
          : undefined;
        if (images) this.ensureLocalImages(images);
        this.sendMessage(
          msg.workspaceId as string,
          msg.content as string,
          msg.target as string | undefined,
          images,
        );
        return;
      }

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        return;

      case "open_diff":
        this.openDiff(msg.filePath as string, msg.oldString as string, msg.newString as string);
        return;

      case "restart_server":
        this.restartServer();
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
    this.persistWorkspaceNow(id);
    this.persistIndex();
    this.broadcastUI({ type: "workspace_created", workspace: workspace.getInfo() });
  }

  private deleteWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    ws.abortAll();
    this.workspaces.delete(workspaceId);
    deleteWorkspaceState(this.baseDir, workspaceId);
    this.persistIndex();
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
    this.persistWorkspaceNow(workspaceId);
    this.broadcastUI({ type: "agent_added", workspaceId, agent });
  }

  private removeAgent(workspaceId: string, agentId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    workspace.removeAgent(agentId);
    this.persistWorkspaceNow(workspaceId);
    this.broadcastUI({ type: "agent_removed", workspaceId, agentId });
  }

  private ensureLocalImages(
    images: Array<{ name: string; url: string; path: string }>,
  ): void {
    const remoteBase = this.config.server.remote_uploads_url;
    if (!remoteBase) return;

    for (const img of images) {
      if (fs.existsSync(img.path)) continue;
      const filename = path.basename(img.url);
      const url = `${remoteBase}/${filename}`;
      console.log(`[ensureLocalImages] downloading ${url} → ${img.path}`);
      try {
        this.downloadFile(url, img.path);
        console.log(`[ensureLocalImages] saved ${fs.statSync(img.path).size} bytes`);
      } catch (e) {
        console.error(`[ensureLocalImages] failed to download ${url}:`, e);
      }
    }
  }

  private downloadFile(url: string, dest: string): void {
    execSync(`curl -sfL --connect-timeout 10 --max-time 30 -o ${JSON.stringify(dest)} ${JSON.stringify(url)}`, {
      timeout: 35000,
    });
  }

  private async sendMessage(
    workspaceId: string,
    content: string,
    target?: string,
    images?: Array<{ name: string; url: string; path: string }>,
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.broadcastUI({ type: "error", message: "Workspace not found" });
      return;
    }

    try {
      await workspace.sendMessage(content, target, images);
    } catch (e) {
      this.broadcastUI({
        type: "error",
        message: `${e instanceof Error ? e.message : e}`,
      });
    }

    this.persistWorkspace(workspaceId);
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

  private openDiff(filePath: string, oldString: string, newString: string): void {
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const tmpDir = os.tmpdir();
    const oldFile = path.join(tmpDir, `${baseName}.old${ext}`);
    const newFile = path.join(tmpDir, `${baseName}.new${ext}`);
    fs.writeFileSync(oldFile, oldString);
    fs.writeFileSync(newFile, newString);
    try {
      execSync(`code --diff "${oldFile}" "${newFile}"`, { timeout: 5000 });
    } catch {
      // VS Code might not be in PATH; ignore
    }
  }

  private restartServer(): void {
    console.log("[restart] Persisting all state before restart...");
    this.persistAll();
    this.broadcastUI({ type: "error", message: "Server is restarting..." });

    const script = `#!/bin/bash
sleep 1
systemctl --user restart agent-team-server
`;
    const tmpScript = path.join(os.tmpdir(), "agent-team-restart.sh");
    fs.writeFileSync(tmpScript, script, { mode: 0o755 });

    const child = spawn("bash", [tmpScript], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    console.log("[restart] Detached restart script launched, shutting down...");
    setTimeout(() => process.exit(0), 500);
  }

  private persistWorkspace(workspaceId: string): void {
    if (this.persistTimers.has(workspaceId)) return;
    this.persistTimers.set(
      workspaceId,
      setTimeout(() => {
        this.persistTimers.delete(workspaceId);
        const ws = this.workspaces.get(workspaceId);
        if (ws) saveWorkspace(this.baseDir, ws.getState());
      }, 500),
    );
  }

  private persistWorkspaceNow(workspaceId: string): void {
    const timer = this.persistTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(workspaceId);
    }
    const ws = this.workspaces.get(workspaceId);
    if (ws) saveWorkspace(this.baseDir, ws.getState());
  }

  private persistIndex(): void {
    saveIndex(this.baseDir, [...this.workspaces.keys()]);
  }

  private persistAll(): void {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const ws of this.workspaces.values()) {
      saveWorkspace(this.baseDir, ws.getState());
    }
    this.persistIndex();
  }

  private restoreState(): void {
    const states = loadAll(this.baseDir);
    if (states.length === 0) return;

    for (const wsState of states) {
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
        this.persistWorkspace(wsId);
      },
      onAgentBusy: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_busy", workspaceId: wsId, agentId });
      },
      onAgentIdle: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_idle", workspaceId: wsId, agentId });
      },
    };
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.persistAll();
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

function shutdown() {
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, saving state before exit:", err);
  server.close();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection, saving state before exit:", reason);
  server.close();
  process.exit(1);
});
