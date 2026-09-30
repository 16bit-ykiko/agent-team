import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { WebSocketServer, WebSocket } from "ws";
import { Workspace, WorkspaceCallbacks, type ProjectLink } from "../workspace/workspace";
import {
  saveWorkspace,
  deleteWorkspaceState,
  saveIndex,
  loadAll,
  loadWorkspaceMessages,
  historyFile,
  historyIndexFile,
  closeHistory,
  appendLog,
  isLoggedEvent,
  loadSettings,
  saveSettings,
  RuntimeSettings,
} from "../workspace/state";
import { loadConfig, AppConfig, effectiveAccount, pickFailoverAccount } from "../config/config";
import { AGENT_PRESETS, MODEL_OPTIONS, backendForModel } from "../config/presets";
import { CommandInfo, StreamEvent } from "../session/claude";
import { HostRegistry, LocalHost } from "../session/host";
import { completeDirs, resolveWorkspacePath } from "../repo/dirs";
import { GitScanner } from "../repo/scanner";
import { HistoryService, sidebarHits, type SearchHit } from "../workspace/history-service";
import { summarizeMessages } from "../workspace/summary";
import { ProjectManager, type ProjectHost } from "../project/manager";
import { Auth } from "./auth";
import { mergeLocalCommands } from "./commands";
import { HttpHandler } from "./http";
import { QuotaMonitor } from "./quota";
import { SystemMonitor } from "./system";

function stripEventsInnerEvents(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (!e.subagent?.events?.length) return e;
    return {
      ...e,
      subagent: { ...e.subagent, eventCount: e.subagent.events.length, events: undefined },
    };
  });
}

const execFileAsync = promisify(execFile);

// Protocol-level ping cadence; a client that misses one round is dropped.
const HEARTBEAT_INTERVAL_MS = 30_000;

export class Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private workspaces = new Map<string, Workspace>();
  private uiClients = new Set<WebSocket>();
  private config: AppConfig;
  private baseDir: string;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private branchTimer: ReturnType<typeof setInterval> | null = null;
  private commands: CommandInfo[] = mergeLocalCommands([]);
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sendOrder = new Map<string, Promise<void>>();
  private uploadsDir: string;
  private hostRegistry: HostRegistry;
  private quotaTimer: ReturnType<typeof setInterval> | null = null;
  private defaultAccount: string | null = null;
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastAccountSwitchAt = 0;
  private archiveTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Clients that answered the last protocol-level ping. Mobile browsers drop
  // sockets without a close frame (screen off, network switch); without this
  // the server keeps writing into a dead socket forever.
  private alive = new WeakSet<WebSocket>();
  private auth: Auth;
  private http: HttpHandler;
  private quota: QuotaMonitor;
  private system = new SystemMonitor();
  private git: GitScanner<Workspace>;
  private projects: ProjectManager;
  private history: HistoryService;

  constructor(port: number, baseDir: string, webDir: string) {
    this.baseDir = baseDir;
    this.history = new HistoryService(historyIndexFile(baseDir), historyFile(baseDir));
    this.uploadsDir = path.join(baseDir, "uploads");
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.config = loadConfig(baseDir);
    const settings = loadSettings(baseDir);
    this.defaultAccount = settings.defaultAccount ?? null;
    if (this.defaultAccount && !this.config.accounts[this.defaultAccount]) {
      this.defaultAccount = null;
    }
    // The SDK only reports its slash commands once a Claude session runs a
    // turn; until then (and forever on codex-only teams) the list would be
    // empty, so start from the last one seen.
    this.commands = mergeLocalCommands(settings.commands ?? []);
    this.hostRegistry = this.initHosts();
    this.auth = new Auth(() => this.config.auth);
    this.quota = new QuotaMonitor(() => this.config.accounts);
    this.git = new GitScanner(
      () => [...this.workspaces.values()].filter((w) => !w.isArchived),
      (w) =>
        this.broadcastUI({ type: "workspace_git_update", workspaceId: w.id, git: w.git, pr: w.pr }),
    );
    this.projects = new ProjectManager(baseDir, this.projectHost());
    this.watchConfig();

    this.http = new HttpHandler(
      this.auth,
      webDir,
      this.uploadsDir,
      baseDir,
      (id) => this.workspaces.get(id)?.cwd,
      (id) => this.workspaces.get(id)?.pr?.base,
    );
    this.httpServer = http.createServer((req, res) => this.http.handle(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info: { req: http.IncomingMessage }) => this.auth.isAuthenticated(info.req),
      // History pages and stream events are highly repetitive JSON; deflate
      // cuts them several-fold, which matters most on mobile links.
      perMessageDeflate: { threshold: 1024 },
    });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    this.heartbeatTimer = setInterval(() => this.sweepDeadClients(), HEARTBEAT_INTERVAL_MS);

    this.restoreState();
    // The search index catches up with the history in the background.
    this.history.changed();
    this.statusTimer = setInterval(() => this.broadcastSystemStatus(), 3000);
    this.branchTimer = setInterval(() => {
      void this.git.scan();
    }, 3000);
    void this.git.scan();
    this.quotaTimer = setInterval(() => this.refreshQuotaIfStale(), 60_000);
    this.sweepArchives();
    this.archiveTimer = setInterval(() => this.sweepArchives(), 3600_000);

    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(`Agent Team server listening on http://0.0.0.0:${port}`);
    });
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

  private refreshQuotaIfStale(): void {
    if (this.uiClients.size > 0) this.quota.refreshIfStale();
  }

  private getSystemStatus(): Record<string, unknown> {
    return { type: "system_status", ...this.system.snapshot(), quota: this.quota.entries };
  }

  private broadcastSystemStatus(): void {
    if (this.uiClients.size === 0) return;
    this.broadcastUI(this.getSystemStatus());
  }

  // settings.json holds several independent values; patch rather than
  // overwrite so one writer does not wipe the others.
  private updateSettings(patch: Partial<RuntimeSettings>): void {
    saveSettings(this.baseDir, { ...loadSettings(this.baseDir), ...patch });
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

  private sweepDeadClients(): void {
    for (const ws of this.uiClients) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }

  private onConnect(ws: WebSocket): void {
    this.uiClients.add(ws);
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    // ws emits 'error' for frames it cannot parse (invalid UTF-8, bad
    // opcode); unhandled, that is an uncaught exception that kills every turn.
    ws.on("error", () => ws.terminate());

    ws.on("message", (raw) => {
      try {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
        this.handleMessage(ws, msg);
      } catch (e) {
        this.sendJson(ws, { type: "error", message: `Invalid message: ${String(e)}` });
      }
    });

    ws.on("close", () => {
      this.uiClients.delete(ws);
    });

    this.sendJson(ws, {
      type: "init",
      // Identifies the served bundle; a client that reconnects and sees a
      // different id reloads itself (home-screen apps never reload on their own).
      buildId: this.http.buildId(),
      workspaces: [...this.workspaces.values()].map((w) => w.getInfo(false)),
      config: {
        accounts: Object.keys(this.config.accounts),
        defaultAccount: this.defaultAccount,
        presets: AGENT_PRESETS,
        models: MODEL_OPTIONS,
        commands: this.commands,
        hosts: this.config.hosts,
        archiveAfterDays: this.config.workspace.archive_after_days,
      },
      hosts: this.hostRegistry.getAllInfo(),
      projects: this.projects.list(),
    });
    this.sendJson(ws, this.getSystemStatus());
    this.refreshQuotaIfStale();
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "load_messages": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace && this.ensureLoaded(workspace)) {
          const before = (msg.before as number) ?? Infinity;
          const limit = Math.min((msg.limit as number) ?? 50, 200);
          const all = workspace.getMessages();
          const older = before === Infinity ? all : all.filter((m) => m.timestamp < before);
          // A prompt and its reply often share a millisecond, and the client
          // only knows the oldest message it has, not which of its same-ms
          // neighbours it has: send all of them on top of the page (the client
          // drops duplicates by id).
          const tied = before === Infinity ? [] : all.filter((m) => m.timestamp === before);
          const page = [...older.slice(-limit), ...tied];
          this.sendJson(ws, {
            type: "workspace_messages",
            workspaceId: workspace.id,
            messages: summarizeMessages(page),
            hasMore: older.length > limit,
            // Echoed so the client can tell an older page from a resync of
            // the newest one (the latter replaces, the former prepends).
            before: before === Infinity ? null : before,
          });
        }
        return;
      }

      case "load_message_details": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace || !this.ensureLoaded(workspace)) return;
        const message = workspace.getMessages().find((m) => m.id === msg.messageId);
        if (!message) return;
        this.sendJson(ws, {
          type: "message_details",
          workspaceId: workspace.id,
          messageId: message.id,
          events: stripEventsInnerEvents(message.events ?? []),
        });
        return;
      }

      case "load_subagent_events": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace && this.ensureLoaded(workspace)) {
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
          msg.path as string,
          msg.hostId as string | undefined,
        );
        return;

      case "create_project":
        this.createProject(
          ws,
          msg.name as string,
          msg.path as string,
          msg.model as string | undefined,
        );
        return;

      case "rename_project":
        this.projectAction(ws, () =>
          this.projects.rename(msg.projectId as string, msg.name as string),
        );
        return;

      case "delete_project":
        this.projectAction(ws, () => this.projects.delete(msg.projectId as string));
        return;

      case "list_dirs":
        this.sendJson(ws, {
          type: "dirs",
          prefix: msg.prefix,
          dirs: completeDirs((msg.prefix as string) ?? ""),
        });
        return;

      case "search": {
        const query = (msg.query as string) ?? "";
        this.search(query)
          .catch((e: unknown) => {
            console.error("[search]", e);
            return [];
          })
          .then((hits) => this.sendJson(ws, { type: "search_results", query, hits }))
          .catch(() => {});
        return;
      }

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
          msg.account as string | undefined,
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
        const quote = msg.quote as
          { messageId: string; agentId: string | null; content: string } | undefined;
        const send = () =>
          this.sendMessage(
            msg.workspaceId as string,
            msg.content as string,
            msg.target as string | undefined,
            images,
            quote,
          );
        // Sends keep their order even when one waits on an image download.
        const wsId = msg.workspaceId as string;
        const missing = images?.filter((img) => !fs.existsSync(img.path)) ?? [];
        const prev = this.sendOrder.get(wsId);
        if (!prev && missing.length === 0) {
          void send();
          return;
        }
        const next = (prev ?? Promise.resolve())
          .then(() => (missing.length ? this.fetchRemoteImages(missing) : undefined))
          .then(() => {
            void send();
          });
        this.sendOrder.set(wsId, next);
        void next.finally(() => {
          if (this.sendOrder.get(wsId) === next) this.sendOrder.delete(wsId);
        });
        return;
      }

      case "abort":
        this.abortAgent(msg.workspaceId as string, msg.agentId as string | undefined);
        return;

      // Stop the running turn only; background tasks and wake-ups go on.
      case "interrupt": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const agentId = msg.agentId as string | undefined;
        if (!workspace) return;
        void (agentId ? workspace.interruptAgent(agentId) : workspace.interruptAll()).catch(
          (e: unknown) =>
            this.sendJson(ws, {
              type: "error",
              message: `Stop failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
        );
        return;
      }

      case "cancel_wakeup": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const refused = workspace
          ? workspace.cancelWake(msg.agentId as string)
          : "No wake-up to cancel";
        if (refused) this.sendJson(ws, { type: "error", message: refused });
        return;
      }

      case "set_default_account":
        this.setDefaultAccount(ws, (msg.account as string | null) ?? null);
        return;

      case "archive_workspace":
        this.archiveWorkspace(msg.workspaceId as string, false);
        return;

      case "unarchive_workspace": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (workspace) this.unarchiveWorkspace(workspace);
        return;
      }

      case "purge_archived": {
        // One project's archived sessions, those in no project (null), or
        // every one (no projectId). A project goes with its lead: only an
        // explicit delete does that.
        const scope = msg.projectId as string | null | undefined;
        for (const w of [...this.workspaces.values()]) {
          if (!w.isArchived) continue;
          const link = w.projectLink && this.projects.get(w.projectLink.projectId) && w.projectLink;
          if (scope === null && link) continue;
          if (scope && link?.projectId !== scope) continue;
          if (link?.role === "lead") continue;
          this.deleteWorkspace(w.id);
        }
        return;
      }

      case "archive_project":
        this.projectAction(ws, () =>
          this.projects.setArchived(msg.projectId as string, msg.archived !== false),
        );
        return;

      case "cancel_queued": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace || !this.ensureLoaded(workspace)) return;
        if (workspace.cancelQueued(msg.messageId as string)) {
          this.persistWorkspace(workspace.id);
          this.broadcastUI({
            type: "message_removed",
            workspaceId: workspace.id,
            messageId: msg.messageId,
          });
        }
        return;
      }

      case "debug_rate_limit": {
        if (process.env.AGENT_TEAM_DEBUG !== "1") return;
        const workspace = this.workspaces.get(msg.workspaceId as string);
        const entry = workspace?.agents.get(msg.agentId as string);
        entry?.session.simulateRateLimit?.({
          rateLimitType: msg.rateLimitType as string | undefined,
          resetsAt: msg.resetsAt as number | undefined,
        });
        return;
      }

      case "cancel_subagent": {
        const workspace = this.workspaces.get(msg.workspaceId as string);
        if (!workspace) {
          this.sendJson(ws, { type: "error", message: "Workspace not found" });
          return;
        }
        try {
          workspace.cancelSubagent(msg.agentId as string, msg.taskId as string);
        } catch (e) {
          this.sendJson(ws, {
            type: "error",
            message: `${e instanceof Error ? e.message : String(e)}`,
          });
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
        void this.forwardMessage(
          msg.workspaceId as string,
          msg.messageId as string,
          msg.targetAgentId as string,
        );
        return;

      case "restart_server":
        this.restartServer();
        return;

      // Application-level liveness probe: browsers cannot see ws ping/pong
      // frames, so the client sends its own and expects a reply.
      case "ping":
        this.sendJson(ws, { type: "pong" });
        return;

      default:
        this.sendJson(ws, { type: "error", message: `Unknown message type: ${String(msg.type)}` });
    }
  }

  private createWorkspace(ws: WebSocket, name: string, pathInput: string, hostId?: string): void {
    const cwd = resolveWorkspacePath(pathInput ?? "");
    if (!cwd) {
      this.sendJson(ws, { type: "error", message: `Not a directory: ${pathInput}` });
      return;
    }
    // A workspace is a session of its folder's project (made, with its lead,
    // if the folder has none yet).
    this.projectAction(ws, () => {
      const project = this.projects.ensureFor(cwd);
      this.makeWorkspace(name, cwd, hostId, { projectId: project.id, role: "worker" });
    });
  }

  private makeWorkspace(
    name: string,
    cwd: string,
    hostId?: string,
    projectLink?: ProjectLink,
  ): Workspace {
    const resolvedHostId = hostId || this.hostRegistry.getDefault()?.id || "local";
    const id = genId("ws");
    const workspace = new Workspace(
      id,
      name,
      path.basename(cwd),
      resolvedHostId,
      cwd,
      this.hostRegistry,
      this.makeCallbacks(),
    );

    // Same-folder workspaces share the scanner's cache; seed from it so the
    // header has branch/PR info from the first frame.
    const cached = this.git.cached(cwd);
    if (cached) {
      workspace.git = cached.git;
      workspace.pr = cached.pr;
    }
    workspace.projectLink = projectLink;
    this.workspaces.set(id, workspace);
    try {
      this.persistWorkspaceNow(id);
      this.persistIndex();
    } catch (e) {
      this.workspaces.delete(id);
      workspace.dispose();
      throw e;
    }
    this.broadcastUI({ type: "workspace_created", workspace: workspace.getInfo() });
    return workspace;
  }

  // Deleting a project's lead deletes the project; a worker leaves its
  // objectives.
  private deleteWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    const link = ws.projectLink;
    if (link?.role === "lead" && this.projects.get(link.projectId)) {
      this.projects.delete(link.projectId);
      return;
    }
    this.projects.forget(ws);
    this.removeWorkspace(workspaceId);
  }

  private removeWorkspace(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    ws.dispose();
    const timer = this.persistTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.persistTimers.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    deleteWorkspaceState(this.baseDir, workspaceId);
    this.history.changed();
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
    account?: string,
  ): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.sendJson(ws, { type: "error", message: "Workspace not found" });
      return;
    }

    try {
      if (account && !this.config.accounts[account]) {
        this.sendJson(ws, { type: "error", message: `Unknown account: ${account}` });
        return;
      }
      this.addAgentTo(workspace, name, model, avatar, color, permissionMode, account);
    } catch (e) {
      this.sendJson(ws, {
        type: "error",
        message: `${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private addAgentTo(
    workspace: Workspace,
    name: string,
    model: string,
    avatar: string,
    color: string,
    permissionMode?: string,
    account?: string,
  ): void {
    const preset = MODEL_OPTIONS.find((m) => m.id === model);
    const backend = backendForModel(model);
    const agent = workspace.addAgent(
      name,
      model,
      avatar,
      color,
      {
        backend,
        effort: preset?.effort,
        permissionMode: backend === "codex" ? undefined : (permissionMode ?? "bypassPermissions"),
        providerEnv: this.sessionEnv(model, account),
      },
      account,
    );
    const tools = this.projects.toolsFor(workspace);
    if (tools) workspace.agents.get(agent.id)?.session.setPanelTools?.(tools);
    this.persistWorkspaceNow(workspace.id);
    this.broadcastUI({ type: "agent_added", workspaceId: workspace.id, agent });
  }

  // Long-lived OAuth token (from `claude setup-token`) for a named account;
  // the env var takes precedence over the locally logged-in credentials in
  // the spawned session, which is exactly the multi-account switch we want.
  private resolveAccountEnv(account?: string): Record<string, string> | undefined {
    const token = account ? this.config.accounts[account]?.oauth_token : undefined;
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : undefined;
  }

  private sessionEnv(model: string, account?: string): Record<string, string> | undefined {
    const resolved = effectiveAccount(account, this.defaultAccount, this.config.accounts);
    const provider = this.resolveProviderEnv(model);
    const acct = this.resolveAccountEnv(resolved);
    if (!provider && !acct) return undefined;
    return { ...provider, ...acct };
  }

  // Re-resolve credentials for every live session (after a config reload or a
  // default-account switch). Idle Claude sessions restart their query on the
  // next message, resuming the same session id under the new account.
  private reapplyAccountEnv(): void {
    for (const ws of this.workspaces.values()) {
      for (const entry of ws.agents.values()) {
        entry.session.setProviderEnv?.(this.sessionEnv(entry.info.model, entry.info.account));
      }
    }
  }

  private setDefaultAccount(ws: WebSocket, account: string | null): void {
    if (account && !this.config.accounts[account]) {
      this.sendJson(ws, { type: "error", message: `Unknown account: ${account}` });
      return;
    }
    this.defaultAccount = account;
    this.updateSettings({ defaultAccount: account });
    this.reapplyAccountEnv();
    this.broadcastUI({ type: "default_account", account });
  }

  // Hot-reload config.toml: accounts/providers/presets apply live (the port
  // and auth cookie secret need a restart). watchFile (polling) survives the
  // atomic rename-writes editors do, unlike fs.watch.
  private watchConfig(): void {
    const configPath = path.join(this.baseDir, "config.toml");
    fs.watchFile(configPath, { interval: 2000 }, () => {
      try {
        this.config = loadConfig(this.baseDir);
      } catch (e) {
        this.broadcastUI({
          type: "error",
          message: `config.toml reload failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      if (this.defaultAccount && !this.config.accounts[this.defaultAccount]) {
        this.defaultAccount = null;
        this.updateSettings({ defaultAccount: null });
        this.broadcastUI({ type: "default_account", account: null });
      }
      this.reapplyAccountEnv();
      this.quota.invalidate();
      this.refreshQuotaIfStale();
      this.broadcastUI({
        type: "config_update",
        accounts: Object.keys(this.config.accounts),
        defaultAccount: this.defaultAccount,
      });
      console.log("[config] reloaded config.toml");
    });
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

    const dropped = workspace.removeAgent(agentId);
    if (!dropped) return;
    this.persistWorkspaceNow(workspaceId);
    for (const messageId of dropped) {
      this.broadcastUI({ type: "message_removed", workspaceId, messageId });
    }
    this.broadcastUI({ type: "agent_removed", workspaceId, agentId });
  }

  private async fetchRemoteImages(
    images: Array<{ name: string; url: string; path: string }>,
  ): Promise<void> {
    const remoteBase = this.config.server.remote_uploads_url;
    if (!remoteBase) return;
    await Promise.all(
      images.map(async (img) => {
        const filename = path.basename(img.url);
        if (!/^[\w.-]+$/.test(filename)) return;
        const url = `${remoteBase}/${filename}`;
        try {
          await execFileAsync(
            "curl",
            ["-sfL", "--connect-timeout", "10", "--max-time", "30", "-o", img.path, url],
            { timeout: 35000 },
          );
          console.log(`[fetchRemoteImages] ${url} → ${img.path}`);
        } catch (e) {
          console.error(`[fetchRemoteImages] failed to download ${url}:`, e);
        }
      }),
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
    if (!this.unarchiveWorkspace(workspace)) return;

    try {
      await workspace.sendMessage(content, target, images, quote);
    } catch (e) {
      this.broadcastUI({
        type: "error",
        message: `${e instanceof Error ? e.message : String(e)}`,
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
    if (!workspace || !this.unarchiveWorkspace(workspace)) return;
    try {
      await workspace.forwardMessage(messageId, targetAgentId);
    } catch (e) {
      this.broadcastUI({ type: "error", message: `${e instanceof Error ? e.message : String(e)}` });
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
        if (!ws) return;
        try {
          this.save(ws);
        } catch (e) {
          // A full disk, another process holding the database: the changes
          // stay marked for the next try.
          console.error(`[state] ${workspaceId}: not saved, trying again`, e);
          setTimeout(() => this.persistWorkspace(workspaceId), 5000);
        }
      }, 500),
    );
  }

  private persistWorkspaceNow(workspaceId: string, all = false): void {
    const timer = this.persistTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(workspaceId);
    }
    const ws = this.workspaces.get(workspaceId);
    if (ws) this.save(ws, all);
  }

  // Writes the messages that changed; with `all`, compares every one, which
  // is done before a history leaves memory.
  private save(ws: Workspace, all = false): void {
    const changed = ws.takeChanged();
    try {
      if (saveWorkspace(this.baseDir, ws.getState(), all ? "all" : changed)) {
        this.history.changed();
      }
    } catch (e) {
      ws.touch(changed);
      throw e;
    }
  }

  private unload(ws: Workspace): void {
    this.persistWorkspaceNow(ws.id, true);
    ws.unloadMessages();
  }

  private persistIndex(): void {
    saveIndex(this.baseDir, [...this.workspaces.keys()]);
  }

  private persistAll(): void {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    for (const ws of this.workspaces.values()) {
      // An unloaded workspace is persisted whenever it changes (archive,
      // unarchive); rewriting it here re-read and re-wrote hundreds of MB.
      if (!ws.messagesLoaded) continue;
      try {
        this.save(ws, true);
      } catch (e) {
        console.error(`[state] ${ws.id}: not saved`, e);
      }
    }
    this.persistIndex();
  }

  private restoreState(): void {
    const states = loadAll(this.baseDir);
    if (states.length === 0) return;

    for (const wsState of states) {
      for (const agent of wsState.agents) {
        agent.session.config.providerEnv = this.sessionEnv(agent.model, agent.account);
      }
      const workspace = Workspace.fromState(wsState, this.hostRegistry, this.makeCallbacks());
      if (workspace.isArchived) workspace.unloadMessages();
      this.workspaces.set(workspace.id, workspace);
      // Turns the stop cut short are written (and searchable) right away.
      if (workspace.hasChanges()) this.persistWorkspaceNow(workspace.id);
      const tools = this.projects.toolsFor(workspace);
      if (tools) for (const a of workspace.agents.values()) a.session.setPanelTools?.(tools);
    }
    // Messages still queued when the server went down; spaced out so a
    // restart does not start many CLI sessions at once.
    let delay = 1000;
    for (const workspace of this.workspaces.values()) {
      if (workspace.isArchived) continue;
      for (const agentId of workspace.agents.keys()) {
        if (!workspace.messages.some((m) => m.status === "queued" && m.queuedFor === agentId)) {
          continue;
        }
        setTimeout(() => workspace.dequeueNext(agentId), delay);
        delay += 5000;
      }
    }

    try {
      this.projects.adoptAll();
    } catch (e) {
      console.error("[projects] workspaces from before projects stay on their own", e);
    }
    const archived = [...this.workspaces.values()].filter((w) => w.isArchived).length;
    console.log(`Restored ${this.workspaces.size} workspace(s), ${archived} archived`);
  }

  // ---- Projects ---------------------------------------------------------

  private createProject(ws: WebSocket, name: string, pathInput: string, model?: string): void {
    const root = resolveWorkspacePath(pathInput ?? "");
    if (!root) {
      this.sendJson(ws, { type: "error", message: `Not a directory: ${pathInput}` });
      return;
    }
    this.projectAction(ws, () =>
      this.projects.create(name?.trim() || path.basename(root), root, model || undefined),
    );
  }

  private projectAction(ws: WebSocket, action: () => unknown): void {
    try {
      action();
    } catch (e) {
      this.sendJson(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  // What was said, in every history.
  private search(query: string): Promise<SearchHit[]> {
    const sessions = [...this.workspaces.values()].map((w) => ({ id: w.id, name: w.name }));
    return sidebarHits(this.history, query, sessions, 50);
  }

  private projectHost(): ProjectHost {
    return {
      workspaces: () => this.workspaces.values(),
      workspace: (id) => this.workspaces.get(id),
      createWorkspace: (name, cwd, link) => this.makeWorkspace(name, cwd, undefined, link),
      addAgent: (w, name, model, avatar, color) => this.addAgentTo(w, name, model, avatar, color),
      removeWorkspace: (id) => this.removeWorkspace(id),
      archiveWorkspace: (w) => {
        if (!w.isIdle) return false;
        this.archiveWorkspace(w.id, true);
        return true;
      },
      restoreWorkspace: (w) => this.unarchiveWorkspace(w),
      loadWorkspace: (w) => this.ensureLoaded(w),
      history: this.history,
      persistWorkspace: (w) => this.persistWorkspace(w.id),
      saveWorkspaceNow: (w) => this.persistWorkspaceNow(w.id),
      workspaceChanged: (w) =>
        this.broadcastUI({ type: "workspace_updated", workspace: w.getInfo(false) }),
      broadcast: (msg) => this.broadcastUI(msg),
    };
  }

  // ---- Archiving -------------------------------------------------------
  // An archived workspace stays in the list but costs nothing: its history
  // is on disk only, its idle CLI child processes are gone, and the branch
  // scanner skips it. Any interaction that needs the history restores it.

  // False when the history on disk cannot be read; the workspace then stays
  // unloaded so nothing saves an empty history over it.
  private ensureLoaded(ws: Workspace): boolean {
    if (ws.messagesLoaded) return true;
    try {
      ws.setMessages(loadWorkspaceMessages(this.baseDir, ws.id));
      return true;
    } catch (e) {
      console.error(`[state] ${ws.id}: history unreadable`, e);
      this.broadcastUI({
        type: "error",
        message: `History of "${ws.name}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  private archiveWorkspace(workspaceId: string, auto: boolean): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.isArchived) return;
    if (ws.projectLink?.role === "lead") {
      if (!auto) {
        this.broadcastUI({
          type: "error",
          message: "A lead goes with its project: archive the project from its board",
        });
      }
      return;
    }
    if (!ws.isIdle) {
      if (!auto) this.broadcastUI({ type: "error", message: "Workspace is still busy" });
      return;
    }
    ws.abortAll();
    ws.archivedAt = Date.now();
    this.unload(ws);
    this.broadcastUI({ type: "workspace_archived", workspaceId, archivedAt: ws.archivedAt });
  }

  private unarchiveWorkspace(ws: Workspace): boolean {
    if (!this.ensureLoaded(ws)) return false;
    if (!ws.isArchived) return true;
    ws.archivedAt = null;
    this.persistWorkspaceNow(ws.id);
    this.broadcastUI({ type: "workspace_unarchived", workspaceId: ws.id });
    try {
      this.projects.adopt(ws);
    } catch (e) {
      console.error(`[projects] ${ws.id} stays outside a project`, e);
    }
    return true;
  }

  private sweepArchives(): void {
    const days = this.config.workspace.archive_after_days;
    if (!days) return;
    const cutoff = Date.now() - days * 86400_000;
    for (const ws of this.workspaces.values()) {
      if (ws.isArchived) {
        // Browsing an archived workspace loads its history; let it go again
        // once nothing is happening there.
        if (ws.messagesLoaded && ws.isIdle) this.unload(ws);
        continue;
      }
      if (ws.lastActivityAt > cutoff || ws.projectLink?.role === "lead") continue;
      this.archiveWorkspace(ws.id, true);
    }
  }

  // Rate-limit recovery policy:
  //  - five_hour: hold the agent's queue and auto-retry the failed prompt
  //    shortly after the window resets ("wait it out")
  //  - weekly-type limits (seven_day / fable pools): fail over the DEFAULT
  //    account to another credential and retry immediately — agents pinned to
  //    an explicit account are left alone (switching under them would be
  //    surprising), they just get the error message.
  private handleRateLimit(
    wsId: string,
    agentId: string,
    info: { rateLimitType?: string; resetsAt?: number },
  ): void {
    const ws = this.workspaces.get(wsId);
    const entry = ws?.agents.get(agentId);
    if (!ws || !entry) return;
    const agentName = entry.info.name;

    if (!info.rateLimitType || info.rateLimitType === "five_hour") {
      const resetMs = info.resetsAt ? info.resetsAt * 1000 : Date.now() + 30 * 60_000;
      // Retry one minute after the reset; never sooner than 1 min or later
      // than 6 h from now (clock skew / bogus resets).
      const delay = Math.min(Math.max(resetMs - Date.now() + 60_000, 60_000), 6 * 3600_000);
      ws.pauseAgent(agentId, Date.now() + delay);
      const at = new Date(Date.now() + delay).toLocaleTimeString();
      ws.postSystemMessage(`⏳ **${agentName}** hit the 5-hour limit — auto-retrying at ${at}.`);
      const key = `${wsId}:${agentId}`;
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.set(
        key,
        setTimeout(() => {
          this.retryTimers.delete(key);
          const w = this.workspaces.get(wsId);
          if (w && !w.retryLast(agentId)) w.dequeueNext(agentId);
        }, delay),
      );
      return;
    }

    // Weekly-type limit.
    if (entry.info.account) {
      ws.postSystemMessage(
        `🚫 **${agentName}** hit the ${info.rateLimitType.replace(/_/g, "-")} limit on its pinned account \`${entry.info.account}\`. Switch its account manually if needed.`,
      );
      return;
    }
    // Debounce: if both credentials are exhausted the rotations would
    // ping-pong; allow one auto-switch per 5 minutes.
    if (Date.now() - this.lastAccountSwitchAt < 5 * 60_000) return;

    const current = effectiveAccount(undefined, this.defaultAccount, this.config.accounts);
    const next = pickFailoverAccount(current, this.config.accounts);
    if (next === undefined) return; // nowhere to go — the error message stands

    this.lastAccountSwitchAt = Date.now();
    this.defaultAccount = next;
    this.updateSettings({ defaultAccount: next });
    this.reapplyAccountEnv();
    this.broadcastUI({ type: "default_account", account: next });
    ws.postSystemMessage(
      `🔁 ${info.rateLimitType.replace(/_/g, "-")} limit on \`${current ?? "local"}\` — switched the default account to \`${next ?? "local"}\` and retrying.`,
    );
    setTimeout(() => {
      const w = this.workspaces.get(wsId);
      if (!w) return;
      // The old query was started with the previous account's credentials
      // (setProviderEnv couldn't abort it because the turn was still
      // processing). Kill it so the retry starts a fresh query.
      const e = w.agents.get(agentId);
      if (e) e.session.abort();
      if (!w.retryLast(agentId)) w.dequeueNext(agentId);
    }, 1000);
  }

  private makeCallbacks(): WorkspaceCallbacks {
    return {
      onNewMessage: (wsId, msg) => {
        this.broadcastUI({ type: "new_message", workspaceId: wsId, message: msg });
      },
      onStreamEvent: (wsId, agentMsg, event) => {
        if (isLoggedEvent(event)) {
          appendLog(this.baseDir, wsId, { timestamp: Date.now(), messageId: agentMsg.id, event });
        }
        this.broadcastUI({
          type: "stream_event",
          workspaceId: wsId,
          messageId: agentMsg.id,
          event,
        });
        // A finished message changed later (a background task's end): its
        // turn will not save it.
        if (agentMsg.status !== "streaming") this.persistWorkspace(wsId);
      },
      onMessageDone: (wsId, msgId, status, content, events, patch) => {
        this.broadcastUI({
          type: "message_done",
          workspaceId: wsId,
          messageId: msgId,
          status,
          content,
          events: events ? stripEventsInnerEvents(events) : undefined,
          ...patch,
        });
        this.persistWorkspace(wsId);
      },
      onAgentBusy: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_busy", workspaceId: wsId, agentId });
      },
      onAgentIdle: (wsId, agentId) => {
        this.broadcastUI({ type: "agent_idle", workspaceId: wsId, agentId });
        // A finished turn is the moment a PR is likely to have appeared or
        // moved; refresh it on the next scan instead of waiting a minute.
        const ws = this.workspaces.get(wsId);
        if (ws) this.git.requestPrRefresh(ws.cwd);
        if (ws) this.projects.workerIdle(ws);
      },
      onAgentState: (wsId, agentId, state) => {
        this.broadcastUI({ type: "agent_state", workspaceId: wsId, agentId, state });
        const ws = this.workspaces.get(wsId);
        if (ws && state === "idle") this.projects.workerIdle(ws);
      },
      onCommandsChanged: (_wsId, commands) => {
        this.commands = mergeLocalCommands(commands);
        this.updateSettings({ commands });
        this.broadcastUI({ type: "commands_update", commands: this.commands });
      },
      onRateLimit: (wsId, agentId, info) => this.handleRateLimit(wsId, agentId, info),
      onAgentUpdated: (wsId, agent, transient) => {
        this.broadcastUI({ type: "agent_updated", workspaceId: wsId, agent });
        if (!transient) this.persistWorkspace(wsId);
      },
      onAgentActivity: (wsId, agentId, activity) => {
        this.broadcastUI({ type: "agent_activity", workspaceId: wsId, agentId, activity });
      },
      onUnhandled: (wsId, agentId, msg) => {
        appendLog(this.baseDir, wsId, { timestamp: Date.now(), agentId, unhandled: msg });
      },
      sessionEnv: (model, account) => this.sessionEnv(model, account),
    };
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.projects.close();
    fs.unwatchFile(path.join(this.baseDir, "config.toml"));
    for (const t of this.retryTimers.values()) clearTimeout(t);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.branchTimer) clearInterval(this.branchTimer);
    if (this.archiveTimer) clearInterval(this.archiveTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    // Turns cut short are saved as such.
    for (const ws of this.workspaces.values()) {
      try {
        ws.abortAll();
      } catch (e) {
        console.error(`[close] ${ws.id}:`, e);
      }
    }
    this.persistAll();
    void this.history.close();
    closeHistory(this.baseDir);
    this.wss.close();
    this.httpServer.close();
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
