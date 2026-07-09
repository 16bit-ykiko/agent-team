import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { Workspace, WorkspaceCallbacks } from "./task";
import { saveWorkspace, deleteWorkspaceState, saveIndex, loadAll, appendLog } from "./state";
import { loadConfig, AppConfig } from "./config";
import { AGENT_PRESETS, MODEL_OPTIONS } from "./presets";
import { CommandInfo, StreamEvent } from "./session";
import { HostRegistry, LocalHost } from "./host";
import type { Message } from "./task";

// Commands handled by this server (Workspace.tryHandleCommand) rather than
// forwarded to the agent. Merged into the SDK command list for autocomplete.
const LOCAL_COMMANDS: CommandInfo[] = [
  {
    name: "effort",
    description: "Show or set the model reasoning effort level",
    argumentHint: "[low|medium|high|xhigh|max]",
  },
];

function mergeLocalCommands(commands: CommandInfo[]): CommandInfo[] {
  const names = new Set(commands.map((c) => c.name));
  return [...LOCAL_COMMANDS.filter((c) => !names.has(c.name)), ...commands];
}

function stripEventsInnerEvents(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (!e.subagent?.events?.length) return e;
    return {
      ...e,
      subagent: { ...e.subagent, eventCount: e.subagent.events.length, events: undefined },
    } as StreamEvent;
  });
}

function stripMessageSubagentEvents(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.events?.some((e) => e.subagent?.events?.length)) return m;
    return { ...m, events: stripEventsInnerEvents(m.events!) };
  });
}

interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

interface QuotaEntry {
  label: string;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  fetchedAt: number;
}

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
  private branchTimer: ReturnType<typeof setInterval> | null = null;
  private branchCache = new Map<string, string | null>();
  private prevCpuIdle = 0;
  private prevCpuTotal = 0;
  private commands: CommandInfo[] = mergeLocalCommands([]);
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private uploadsDir: string;
  private hostRegistry: HostRegistry;
  private quotaEntries: QuotaEntry[] = [];
  private quotaTimer: ReturnType<typeof setInterval> | null = null;

  constructor(port: number, baseDir: string, webDir: string) {
    this.baseDir = baseDir;
    this.webDir = webDir;
    this.uploadsDir = path.join(baseDir, "uploads");
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.config = loadConfig(baseDir);
    this.hostRegistry = this.initHosts();

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info: { req: http.IncomingMessage }) => this.isAuthenticated(info.req),
    });
    this.wss.on("connection", (ws) => this.onConnect(ws));

    this.restoreState();
    this.initCpuBaseline();
    this.statusTimer = setInterval(() => this.broadcastSystemStatus(), 3000);
    this.branchTimer = setInterval(() => this.pollBranches(), 5000);
    this.refreshQuota();
    this.quotaTimer = setInterval(() => this.refreshQuota(), 60000);

    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(`Agent Team server listening on http://0.0.0.0:${port}`);
    });
  }

  private signToken(payload: string): string {
    if (!this.config.auth) return "";
    return crypto
      .createHmac("sha256", this.config.auth.session_secret)
      .update(payload)
      .digest("hex");
  }

  private makeSessionCookie(): string {
    const auth = this.config.auth!;
    const expires = Date.now() + auth.max_age_days * 86400_000;
    const payload = `${auth.username}:${expires}`;
    const sig = this.signToken(payload);
    return `${payload}:${sig}`;
  }

  private validateSessionCookie(cookie: string): boolean {
    if (!this.config.auth) return true;
    const parts = cookie.split(":");
    if (parts.length !== 3) return false;
    const [user, expiresStr, sig] = parts;
    const expires = parseInt(expiresStr);
    if (isNaN(expires) || Date.now() > expires) return false;
    const expected = this.signToken(`${user}:${expiresStr}`);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  }

  private parseCookies(header: string | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!header) return result;
    for (const pair of header.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return result;
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    if (!this.config.auth) return true;
    const cookies = this.parseCookies(req.headers.cookie);
    const token = cookies["agent_team_session"];
    return !!token && this.validateSessionCookie(token);
  }

  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(LOGIN_PAGE);
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 8192) {
          res.statusCode = 413;
          res.end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(body);
        const auth = this.config.auth!;
        if (params.get("username") === auth.username && params.get("password") === auth.password) {
          const cookie = this.makeSessionCookie();
          const maxAge = auth.max_age_days * 86400;
          res.setHeader(
            "Set-Cookie",
            `agent_team_session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
          );
          res.statusCode = 302;
          res.setHeader("Location", "/");
          res.end();
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            LOGIN_PAGE.replace(
              "<!--ERROR-->",
              '<p style="color:#ff6b6b;margin:0 0 16px">用户名或密码错误</p>',
            ),
          );
        }
      });
      return;
    }

    res.statusCode = 405;
    res.end();
  }

  private initHosts(): HostRegistry {
    const registry = new HostRegistry();
    for (const [id, cfg] of Object.entries(this.config.hosts)) {
      registry.register(new LocalHost(id, cfg.label));
    }
    console.log(
      `Hosts: ${registry
        .getAll()
        .map((h) => `${h.id} (${h.type})`)
        .join(", ")}`,
    );
    return registry;
  }

  private refreshQuota(): void {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    let token: string | undefined;
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
      token = creds?.claudeAiOauth?.accessToken;
    } catch {}
    if (!token) return;

    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    this.fetchQuotaForToken(token, body, (entry) => {
      this.quotaEntries = entry ? [{ ...entry, label: "local" }] : [];
    });
  }

  private fetchQuotaForToken(
    token: string,
    body: string,
    cb: (entry: QuotaEntry | null) => void,
  ): void {
    const apiHeaders = {
      "x-api-key": token,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    const handleResponse = (res: http.IncomingMessage) => {
      res.resume();
      const h5 = res.headers["anthropic-ratelimit-unified-5h-utilization"];
      const h5reset = res.headers["anthropic-ratelimit-unified-5h-reset"];
      const d7 = res.headers["anthropic-ratelimit-unified-7d-utilization"];
      const d7reset = res.headers["anthropic-ratelimit-unified-7d-reset"];

      cb({
        label: "",
        fiveHour: h5 ? { utilization: parseFloat(h5 as string), resetsAt: Number(h5reset) } : null,
        sevenDay: d7 ? { utilization: parseFloat(d7 as string), resetsAt: Number(d7reset) } : null,
        fetchedAt: Date.now(),
      });
    };

    const proxy =
      process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.HTTP_PROXY;

    if (proxy) {
      try {
        const proxyUrl = new URL(proxy);
        const proxyReq = http.request({
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          method: "CONNECT",
          path: "api.anthropic.com:443",
          timeout: 10000,
        });
        proxyReq.on("connect", (_res, socket) => {
          const req = https.request(
            {
              hostname: "api.anthropic.com",
              path: "/v1/messages",
              method: "POST",
              headers: apiHeaders,
              socket,
              agent: false,
            } as https.RequestOptions,
            handleResponse,
          );
          req.on("error", () => cb(null));
          req.write(body);
          req.end();
        });
        proxyReq.on("error", () => cb(null));
        proxyReq.on("timeout", () => {
          proxyReq.destroy();
          cb(null);
        });
        proxyReq.end();
      } catch {
        cb(null);
      }
    } else {
      const req = https.request(
        "https://api.anthropic.com/v1/messages",
        { method: "POST", headers: apiHeaders, timeout: 10000 },
        handleResponse,
      );
      req.on("error", () => cb(null));
      req.on("timeout", () => {
        req.destroy();
        cb(null);
      });
      req.write(body);
      req.end();
    }
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

    const memTotal = os.totalmem();
    const memUsed = os.totalmem() - os.freemem();
    const osName = `${os.type()} ${os.release()}`;

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
      quota: this.quotaEntries,
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

      if (this.config.auth) {
        if (pathname === "/login") {
          this.handleLogin(req, res);
          return;
        }
        if (!this.isAuthenticated(req)) {
          res.statusCode = 302;
          res.setHeader("Location", "/login");
          res.end();
          return;
        }
      }

      if (req.method === "POST" && pathname === "/upload") {
        const MAX_UPLOAD = 50 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD) {
            res.statusCode = 413;
            res.end();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
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
        commands: this.commands,
        hosts: this.config.hosts,
      },
      hosts: this.hostRegistry.getAllInfo(),
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
            messages: stripMessageSubagentEvents(page),
            hasMore: filtered.length > limit,
          });
        }
        return;
      }

      case "load_subagent_events": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace) {
          const message = workspace.getMessages().find((m) => m.id === msg.messageId);
          const ev = message?.events?.find((e) => e.subagent?.taskId === msg.taskId);
          this.sendJson(ws, {
            type: "subagent_events",
            workspaceId: msg.workspaceId,
            messageId: msg.messageId,
            taskId: msg.taskId,
            events: ev?.subagent?.events ?? [],
          });
        }
        return;
      }

      case "create_workspace":
        this.createWorkspace(
          ws,
          msg.name as string,
          msg.project as string,
          msg.hostId as string | undefined,
          msg.customPath as string | undefined,
        );
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
        const quote = msg.quote as
          | { messageId: string; agentId: string | null; content: string }
          | undefined;
        this.sendMessage(
          msg.workspaceId as string,
          msg.content as string,
          msg.target as string | undefined,
          images,
          quote,
        );
        return;
      }

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        return;

      case "cancel_subagent": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace) return;
        try {
          workspace.cancelSubagent(msg.agentId as string, msg.taskId as string);
        } catch (e) {
          this.sendJson(ws, { type: "error", message: `${e instanceof Error ? e.message : e}` });
        }
        return;
      }

      case "clear_context": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace) {
          workspace.clearContext(msg.agentId as string);
          this.persistWorkspace(workspace.id);
        }
        return;
      }

      case "forward_message":
        this.forwardMessage(
          msg.workspaceId as string,
          msg.messageId as string,
          msg.targetAgentId as string,
        );
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

  private createWorkspace(
    ws: WebSocket,
    name: string,
    project: string,
    hostId?: string,
    customPath?: string,
  ): void {
    const resolvedHostId = hostId || this.hostRegistry.getDefault()?.id || "local";
    let cwd: string;

    if (customPath) {
      cwd = customPath;
      if (!fs.existsSync(cwd)) {
        this.sendJson(ws, { type: "error", message: `Path does not exist: ${cwd}` });
        return;
      }
    } else {
      const projectPaths = this.config.projects[project];
      if (!projectPaths) {
        this.sendJson(ws, { type: "error", message: `Unknown project: ${project}` });
        return;
      }
      cwd = projectPaths[resolvedHostId];
      if (!cwd) {
        this.sendJson(ws, {
          type: "error",
          message: `Project "${project}" has no path for host "${resolvedHostId}"`,
        });
        return;
      }
    }

    const id = genId("ws");
    const workspace = new Workspace(
      id,
      name,
      project,
      resolvedHostId,
      cwd,
      this.hostRegistry,
      this.makeCallbacks(),
    );

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

    const preset = MODEL_OPTIONS.find((m) => m.id === model);
    const backend = preset?.backend ?? (model.startsWith("gpt-") ? "codex" : "claude");

    try {
      const agent = workspace.addAgent(name, model, avatar, color, {
        backend,
        effort: preset?.effort,
        permissionMode: backend === "codex" ? undefined : (permissionMode ?? "bypassPermissions"),
        providerEnv: this.resolveProviderEnv(model),
      });
      this.persistWorkspaceNow(workspaceId);
      this.broadcastUI({ type: "agent_added", workspaceId, agent });
    } catch (e) {
      this.sendJson(ws, { type: "error", message: `${e instanceof Error ? e.message : e}` });
    }
  }

  private resolveProviderEnv(model: string): Record<string, string> | undefined {
    for (const [name, cfg] of Object.entries(this.config.providers)) {
      if (model.startsWith(name)) {
        return {
          ANTHROPIC_BASE_URL: cfg.base_url,
          ANTHROPIC_AUTH_TOKEN: cfg.api_key,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        };
      }
    }
    return undefined;
  }

  private removeAgent(workspaceId: string, agentId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    workspace.removeAgent(agentId);
    this.persistWorkspaceNow(workspaceId);
    this.broadcastUI({ type: "agent_removed", workspaceId, agentId });
  }

  private ensureLocalImages(images: Array<{ name: string; url: string; path: string }>): void {
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
    execSync(
      `curl -sfL --connect-timeout 10 --max-time 30 -o ${JSON.stringify(dest)} ${JSON.stringify(url)}`,
      {
        timeout: 35000,
      },
    );
  }

  private async sendMessage(
    workspaceId: string,
    content: string,
    target?: string,
    images?: Array<{ name: string; url: string; path: string }>,
    quote?: { messageId: string; agentId: string | null; content: string },
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.broadcastUI({ type: "error", message: "Workspace not found" });
      return;
    }

    try {
      await workspace.sendMessage(content, target, images, quote);
    } catch (e) {
      this.broadcastUI({
        type: "error",
        message: `${e instanceof Error ? e.message : e}`,
      });
    }

    this.persistWorkspace(workspaceId);
  }

  private async forwardMessage(
    workspaceId: string,
    messageId: string,
    targetAgentId: string,
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    try {
      await workspace.forwardMessage(messageId, targetAgentId);
    } catch (e) {
      this.broadcastUI({ type: "error", message: `${e instanceof Error ? e.message : e}` });
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
    const ext = path.extname(path.basename(filePath));
    const rand = Math.random().toString(36).slice(2, 8);
    const tmpDir = os.tmpdir();
    const oldFile = path.join(tmpDir, `diff-${rand}.old${ext}`);
    const newFile = path.join(tmpDir, `diff-${rand}.new${ext}`);
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
      for (const agent of wsState.agents) {
        agent.session.config.providerEnv = this.resolveProviderEnv(agent.model);
      }
      const workspace = Workspace.fromState(wsState, this.hostRegistry, this.makeCallbacks());
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
      onMessageDone: (wsId, msgId, status, content, events) => {
        this.broadcastUI({
          type: "message_done",
          workspaceId: wsId,
          messageId: msgId,
          status,
          content,
          events: events ? stripEventsInnerEvents(events) : undefined,
        });
        this.persistWorkspace(wsId);
      },
      onAgentBusy: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_busy", workspaceId: wsId, agentId });
      },
      onAgentIdle: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_idle", workspaceId: wsId, agentId });
      },
      onCommandsChanged: (_wsId, commands) => {
        this.commands = mergeLocalCommands(commands);
        this.broadcastUI({ type: "commands_update", commands: this.commands });
      },
    };
  }

  private pollBranches(): void {
    const dayAgo = Date.now() - 86_400_000;
    for (const ws of this.workspaces.values()) {
      const lastMsg = ws.messages[ws.messages.length - 1];
      if ((lastMsg?.timestamp ?? ws.createdAt) < dayAgo) continue;
      this.pollBranch(ws);
    }
  }

  private pollBranch(ws: Workspace): void {
    const branch = ws.getGitBranch();
    if (branch === null) return;
    const prev = this.branchCache.get(ws.id);
    if (prev === branch) return;
    this.branchCache.set(ws.id, branch);
    ws.getPrInfo(branch).then((pr) => {
      ws.cachedPrUrl = pr?.url ?? null;
      ws.cachedPrTitle = pr?.title ?? null;
      this.broadcastUI({
        type: "workspace_branch_update",
        workspaceId: ws.id,
        gitBranch: branch,
        prUrl: ws.cachedPrUrl,
        prTitle: ws.cachedPrTitle,
      });
    });
  }

  close(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.branchTimer) clearInterval(this.branchTimer);
    this.persistAll();
    for (const ws of this.workspaces.values()) ws.abortAll();
    this.wss.close();
    this.httpServer.close();
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Agent Team</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;width:320px}
h2{text-align:center;margin-bottom:24px;font-size:20px;color:#e6edf3}
label{display:block;font-size:13px;margin-bottom:6px;color:#8b949e}
input{width:100%;padding:10px 12px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#c9d1d9;font-size:15px;margin-bottom:16px;outline:none}
input:focus{border-color:#58a6ff}
button{width:100%;padding:10px;border:none;border-radius:6px;background:#238636;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:active{background:#2ea043}
</style>
</head><body>
<form method="POST" action="login">
<h2>Agent Team</h2>
<!--ERROR-->
<label>Username</label><input name="username" autocomplete="username" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">Login</button>
</form>
</body></html>`;

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
