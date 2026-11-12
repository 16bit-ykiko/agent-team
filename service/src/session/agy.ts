import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BackgroundTask,
  ContextUsage,
  RunState,
  SessionConfig,
  SessionState,
  StreamEvent,
  UsageStats,
  fenced,
  formatToolUse,
} from "./claude";
import { AppServerClient, RpcRequestError, type Transport } from "./codex-rpc";
import {
  processGroups,
  spawnAgy,
  type ConfigOption,
  type PromptResponse,
  type SessionResponse,
  type SessionUpdate,
  type ToolCall,
} from "./acp";
import { PanelMcpSocket, type StdioServer } from "./panel-mcp";
import type { PanelToolset } from "../project/tools";
import { agyModelId, defaultEffortForModel, effortLevelsForModel } from "../config/presets";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// agy's answer to a resume it cannot do: "Failed to read session <id>;
// retry, or load it with session/load". A load of an id agy does not have
// starts an empty conversation under it.
const RESUME_FAILED = /failed to read session/i;

// agy works on while no prompt runs (it wakes when a background command
// ends) but streams nothing then; session/load replays the conversation,
// what it did meanwhile included (snap fixture agy/background). Its log
// names every model call as it ends: once one comes while idle, a load
// follows when the log has been quiet `settleMs`; a load that found
// something is followed by another after `followUpMs`, and while
// background work runs a load comes every `pollMs` in case the log says
// nothing.
export const IDLE_TIMINGS = { settleMs: 3_000, followUpMs: 10_000, pollMs: 60_000 };
const MODEL_CALL = /streamGenerateContent/;

// The conversation as session/load replays it: one entry per stored
// message (a reply's text comes whole, not in its streamed pieces) and per
// tool call, in its latest state.
type Item = { kind: "user" | "agent" | "thought"; text: string } | { kind: "tool"; call: ToolCall };

interface Call {
  startedAt: number;
  name: string;
  command?: string;
  background: boolean;
  done: boolean;
}

// An agy session is one long-lived `agy acp` process (ACP over stdio, see
// acp.ts) holding one conversation, started on the first message and
// resumed by id after a restart. A turn is one session/prompt; Stop is
// session/cancel. agy runs with every tool permitted, as Claude and Codex
// agents do, the panel's tools reach it as an MCP server (panel-mcp.ts) and
// its instructions as an appended system prompt. Every case below has a
// recording in tests/snap/agy.
export class AgySession extends EventEmitter {
  sessionId: string | null = null;
  config: SessionConfig;
  usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
  };

  // Replaced by the tests and the recorder: the connection a session opens,
  // the panel's MCP server it names, whether it watches agy's log and runs
  // the idle timers (the snap replay calls checkIdle() where the recording
  // did), and a call each time it checks while idle.
  static hooks: {
    transport?: (session: AgySession, args: string[]) => Transport;
    mcpServer?: (session: AgySession) => StdioServer;
    idleTimers?: boolean;
    onIdleCheck?: (session: AgySession) => void;
    onToolAnswer?: (tool: string, args: unknown, text: string, isError: boolean) => void;
  } | null = null;

  private client: AppServerClient | null = null;
  private connecting: Promise<AppServerClient> | null = null;
  private mcp: PanelMcpSocket | null = null;
  private panelTools: PanelToolset | null = null;
  private logFile: string | null = null;
  private logWatch: fs.FSWatcher | null = null;
  private logOffset = 0;
  private agyPid: number | undefined;
  // The model and thought level agy's session has now.
  private applied: { model?: string; effort?: string } = {};

  private busy = false;
  private generation = 0;
  private turnStartedAt = 0;
  private interruptRequested = false;
  private prompting = false;
  private promptSent = false;
  // The prompt came back as a user message: what agy streams before it is
  // left from while it was idle.
  private echoed = false;
  // What loads showed agy say since the last turn, and what of it the
  // stream before the next prompt's echo has repeated so far.
  private shownWake = "";
  private leftoverText = "";
  private leftoverShown = false;
  // What of that stream was shown (text, and whether thoughts).
  private leftoverOwn = "";
  private leftoverThought = false;
  // Follow-up loads still owed to a background command whose end a load
  // showed before agy's reply to it.
  private awaitReply = 0;
  // The reply text the running turn streamed, as agy sent it; at its end,
  // with what it showed before the prompt's echo, for the load after it,
  // which finds all that stored and must not take it for idle work (kept
  // until a load succeeds).
  private ownText = "";
  private ownTurn: { before: string; thought: boolean; after: string } | null = null;
  // agy's slash commands (available_commands_update): a prompt naming one
  // may come back without its command.
  private commands = new Set<string>();
  private textEmitted = false;
  private afterText = false;
  private thinking = "";
  private thinkingSince = 0;
  private thinkingMs = 0;
  private context: ContextUsage | undefined;
  // Every tool call of the process, by id: a background one completes turns
  // later.
  private calls = new Map<string, Call>();
  private background = new Map<string, BackgroundTask>();
  // What the panel's MCP server answered, oldest first, by tool and
  // arguments: agy's update for the call carries no result (agy/turn).
  private answers: Array<{ key: string; text: string; isError: boolean }> = [];
  private state: RunState = "idle";

  // A load in flight collects the replayed updates here; `known` is the
  // conversation as the last load showed it (null: a turn ran since).
  private replay: SessionUpdate[] | null = null;
  private loading: Promise<void> | null = null;
  private known: Item[] | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private followUpTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.busy;
  }

  get runState(): RunState {
    return this.state;
  }

  get backgroundTaskList(): BackgroundTask[] {
    return [...this.background.values()];
  }

  get effectiveEffort(): string | null {
    return (
      this.config.effort ?? (this.config.model ? defaultEffortForModel(this.config.model) : null)
    );
  }

  get interruptPending(): boolean {
    return this.interruptRequested;
  }

  // Model and thought level are config options of agy's session, set before
  // the next prompt.
  setEffort(level: string): void {
    this.config.effort = level;
  }

  setModel(model: string, effort: string | undefined): void {
    this.config.model = model;
    this.config.effort = effort;
  }

  // agy runs on its own Google login.
  setProviderEnv(env: Record<string, string> | undefined): void {
    this.config.providerEnv = env;
  }

  // The MCP server lists them anew on each connection; the instructions go
  // with session/new and session/resume, so the next process takes them.
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
  }

  getState(): SessionState {
    return { sessionId: this.sessionId, config: { ...this.config }, usage: { ...this.usage } };
  }

  static fromState(state: SessionState): AgySession {
    const session = new AgySession(state.config);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }

  getContextUsage(): Promise<Record<string, unknown> | null> {
    const c = this.context;
    if (!c) return Promise.resolve(null);
    return Promise.resolve({
      totalTokens: c.tokens,
      maxTokens: c.window,
      percentage: (c.tokens / c.window) * 100,
      model: this.config.model,
    });
  }

  // --- process ---------------------------------------------------------------

  private connect(): Promise<AppServerClient> {
    if (this.client && !this.client.closed && !this.connecting) {
      return Promise.resolve(this.client);
    }
    if (!this.connecting) {
      const opening = this.open();
      this.connecting = opening;
      void opening
        .finally(() => {
          if (this.connecting === opening) this.connecting = null;
        })
        .catch(() => {});
    }
    return this.connecting;
  }

  private async open(): Promise<AppServerClient> {
    const logFile = path.join(
      os.tmpdir(),
      `agent-team-agy-${process.pid}-${randomBytes(6).toString("hex")}.log`,
    );
    const args = ["--dangerously-skip-permissions", "--log-file", logFile];
    const transport =
      AgySession.hooks?.transport?.(this, args) ?? spawnAgy({ cwd: this.config.cwd, args });
    const client: AppServerClient = new AppServerClient(transport, {
      notification: (method, params) => {
        if (client === this.client) this.onNotification(method, params);
      },
      request: (method, params) =>
        client === this.client
          ? this.onRequest(method, params)
          : Promise.reject(new Error("This session's agy is shutting down.")),
      close: (reason) => this.onClose(client, reason),
    });
    this.client = client;
    this.agyPid = transport.pid;
    this.logFile = logFile;
    this.logOffset = 0;
    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agent-team", version: "0" },
      });
      const params = { cwd: this.config.cwd, ...(await this.sessionParams()) };
      let res: SessionResponse | null = null;
      if (this.sessionId) {
        try {
          res = await client.request<SessionResponse>("session/resume", {
            sessionId: this.sessionId,
            ...params,
          });
        } catch (e) {
          if (!(e instanceof RpcRequestError) || !RESUME_FAILED.test(e.message)) throw e;
          res = await this.reload(client, params);
        }
      }
      if (!this.sessionId) {
        res = await client.request<SessionResponse>("session/new", params);
        if (!res.sessionId) throw new Error("agy started no session");
        if (client !== this.client) throw new Error("agy was replaced while starting.");
        this.sessionId = res.sessionId;
      }
      if (client !== this.client) throw new Error("agy was replaced while starting.");
      this.applied = {};
      this.noteConfig(res?.configOptions);
    } catch (e) {
      if (this.client === client) this.closeProcess();
      else client.close();
      throw e;
    }
    this.watchLog();
    return client;
  }

  // What session/new, resume and load are given: the panel's tools as an
  // MCP server and its instructions appended to agy's system prompt.
  private async sessionParams(): Promise<{ mcpServers: StdioServer[]; _meta?: Obj }> {
    const tools = this.panelTools;
    if (!tools) return { mcpServers: [] };
    let server = AgySession.hooks?.mcpServer?.(this);
    if (!server) {
      if (!this.mcp) {
        const mcp: PanelMcpSocket = new PanelMcpSocket(
          () => this.panelTools,
          (tool, args, text, isError) => {
            if (this.mcp !== mcp) return;
            AgySession.hooks?.onToolAnswer?.(tool, args, text, isError);
            this.noteToolAnswer(tool, args, text, isError);
          },
        );
        this.mcp = mcp;
        await mcp.listen();
      }
      server = this.mcp.command("panel");
    }
    return {
      mcpServers: [server],
      _meta: { antigravity: { systemPrompt: { append: tools.instructions } } },
    };
  }

  // The conversation loaded instead of resumed: its replay is the baseline
  // idle work shows against, and an empty one means agy lost it.
  private async reload(client: AppServerClient, params: Obj): Promise<SessionResponse> {
    const updates: SessionUpdate[] = [];
    this.replay = updates;
    let res: SessionResponse;
    try {
      res = await client.request<SessionResponse>("session/load", {
        sessionId: this.sessionId,
        ...params,
      });
    } finally {
      if (this.replay === updates) this.replay = null;
    }
    const items = conversation(updates);
    this.known = items;
    if (!items.some((i) => i.kind === "user")) {
      this.emit("event", {
        kind: "notice",
        level: "warning",
        content:
          "agy no longer has this conversation; it goes on as a fresh one without the earlier messages.",
      });
    }
    return res;
  }

  private closeProcess(): void {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.stopIdleWatch();
    this.mcp?.close();
    this.mcp = null;
    if (this.logFile) fs.rm(this.logFile, { force: true }, () => {});
    this.logFile = null;
    this.replay = null;
    this.loading = null;
    this.known = null;
    this.ownTurn = null;
    this.awaitReply = 0;
    this.stopCalls();
    this.calls.clear();
    this.answers = [];
    client?.close();
  }

  private onClose(client: AppServerClient, reason: string): void {
    if (client !== this.client) return;
    const busy = this.busy;
    if (busy) {
      this.flushThought();
      this.closeOpen("(stopped)");
    }
    this.closeProcess();
    if (busy) this.endTurn({ kind: "error", content: `[agy error] ${reason}` });
  }

  // Every tool runs unasked (--dangerously-skip-permissions); a request that
  // still comes is allowed once. The client has no file system or terminal
  // of its own to lend.
  private onRequest(method: string, params: Obj): Promise<unknown> {
    if (method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options.map(obj) : [];
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      return Promise.resolve(
        allow
          ? { outcome: { outcome: "selected", optionId: allow.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
    }
    return Promise.reject(new Error(`agent-team does not answer ${method}`));
  }

  noteToolAnswer(tool: string, args: unknown, text: string, isError: boolean): void {
    this.answers.push({ key: callKey(tool, args), text, isError });
  }

  private noteConfig(options: ConfigOption[] | undefined): void {
    for (const o of options ?? []) {
      if (o.id === "model") this.applied.model = o.currentValue;
      if (o.id === "thought_level") this.applied.effort = o.currentValue;
    }
  }

  private async applyConfig(client: AppServerClient): Promise<void> {
    const set = async (configId: string, value: string) => {
      const res = await client.request<SessionResponse>("session/set_config_option", {
        sessionId: this.sessionId,
        configId,
        value,
      });
      this.noteConfig(res?.configOptions);
    };
    const model = this.config.model;
    if (model && agyModelId(model) !== this.applied.model) await set("model", agyModelId(model));
    const effort = this.effectiveEffort;
    if (model && effort && effortLevelsForModel(model).includes(effort)) {
      if (effort !== this.applied.effort) await set("thought_level", effort);
    }
  }

  // --- turns -----------------------------------------------------------------

  async send(message: string): Promise<void> {
    if (this.busy) throw new Error("Session is busy");
    this.generation++;
    const generation = this.generation;
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.interruptRequested = false;
    // Before agy has listed them (its first prompt), any.
    const command = /^\/(\S+)/.exec(message.trimStart())?.[1];
    this.echoed = !!command && (!this.commands.size || this.commands.has(command));
    this.leftoverText = "";
    this.leftoverShown = false;
    this.leftoverOwn = "";
    this.leftoverThought = false;
    this.ownText = "";
    this.promptSent = false;
    this.resetTurn();
    this.stopIdleTimers();
    this.setState("working");
    try {
      const client = await this.connect();
      // A load still replaying: its updates are not this turn's.
      while (this.loading) await this.loading;
      if (generation !== this.generation) return;
      await this.applyConfig(client);
      if (generation !== this.generation) return;
      if (this.interruptRequested) {
        this.endTurn({ kind: "result", content: "", interrupted: true });
        return;
      }
      // What agy did since the last load comes first: the load after this
      // turn is told the turn's own items from the rest by this one.
      if (this.known) await this.startLoad();
      if (generation !== this.generation) return;
      if (this.interruptRequested) {
        this.endTurn({ kind: "result", content: "", interrupted: true });
        return;
      }
      // A panel answer no call of agy's took by now (a subagent's, in a
      // conversation of its own) is no later call's.
      this.answers = [];
      this.prompting = true;
      this.promptSent = true;
      const res = await client.request<PromptResponse>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: message }],
      });
      if (generation !== this.generation) return;
      this.completeTurn(res);
    } catch (e) {
      if (generation === this.generation && this.busy) {
        this.failTurn(`[agy error] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // A background command's card stopped: its process group is ended, and
  // agy reports it over like any command that exited. agy runs each command
  // as `bash -c <command>` leading a group of its own, but bash execs a
  // lone command (and a list's last) in place: a group whose argv is not
  // that is told by start order, when there are as many as commands open.
  stopTask(taskId: string): Promise<void> {
    const call = this.calls.get(taskId);
    if (!call?.background || call.done || !call.command) {
      return Promise.reject(new Error("No such command running in the background."));
    }
    const groups = this.agyPid ? processGroups(this.agyPid) : [];
    const open = [...this.calls.values()]
      .filter((c) => c.command && !c.done)
      .sort((a, b) => a.startedAt - b.startedAt);
    const exact = groups.filter(
      (g) => g.argv[1] === "-c" && g.argv[2] === call.command && /(^|\/)bash$/.test(g.argv[0]),
    );
    const pid =
      exact.length === 1
        ? exact[0].pid
        : groups.length === open.length
          ? groups[open.indexOf(call)]?.pid
          : undefined;
    if (!pid) return Promise.reject(new Error("The command's process could not be told apart."));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return Promise.reject(new Error("The command's process is gone."));
    }
    return Promise.resolve();
  }

  // Stops the running turn; the process lives on. False when none runs.
  interrupt(): Promise<boolean> {
    if (!this.busy) return Promise.resolve(false);
    this.interruptRequested = true;
    if (this.prompting && this.client) {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
    }
    return Promise.resolve(true);
  }

  // Ends the process and with it the turn, which gets no terminal event: the
  // workspace closes its message itself.
  abort(): void {
    this.generation++;
    this.closeProcess();
    if (this.busy) this.endTurn();
  }

  private resetTurn(): void {
    this.textEmitted = false;
    this.afterText = false;
    this.thinking = "";
  }

  private setState(next: RunState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    if (next === "waiting") {
      const tasks = [...this.background.values()];
      const label =
        tasks.length === 1 ? tasks[0].description : `${tasks.length} background commands`;
      this.emit("activity", `waiting on ${label}`);
    } else if (prev === "waiting") {
      this.emit("activity", null);
    }
    this.emit("runState", next);
  }

  private settleState(): void {
    this.setState(this.busy ? "working" : this.background.size ? "waiting" : "idle");
    const poll = this.idleTimers() && !!this.client && this.state === "waiting";
    if (poll && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.checkIdle(), IDLE_TIMINGS.pollMs);
    } else if (!poll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private completeTurn(res: PromptResponse): void {
    this.prompting = false;
    this.flushThought();
    const u = res.usage ?? {};
    const input = u.inputTokens ?? 0;
    const cached = u.cachedReadTokens ?? 0;
    this.usage.input_tokens += input - cached;
    this.usage.output_tokens += u.outputTokens ?? 0;
    this.usage.cache_read_tokens += cached;
    this.usage.cache_creation_tokens += u.cachedWriteTokens ?? 0;
    const stopped = res.stopReason === "cancelled";
    if (stopped) this.closeOpen(this.interruptRequested ? "Interrupted" : "(stopped)");
    else this.sendOpenToBackground();
    if (stopped && !this.interruptRequested) {
      this.endTurn({ kind: "error", content: "[agy error] The turn was cancelled." });
      return;
    }
    if (res.stopReason === "refusal") {
      this.endTurn({ kind: "error", content: "[agy error] The model refused to go on." });
      return;
    }
    const notes: Record<string, string> = {
      max_tokens: "The reply hit the model's output limit.",
      max_turn_requests: "The turn hit agy's limit of model requests.",
    };
    if (notes[res.stopReason]) {
      this.emit("event", { kind: "notice", level: "warning", content: notes[res.stopReason] });
    }
    this.endTurn({
      kind: "result",
      content: "",
      ...(this.context && { context: this.context }),
      ...(this.effectiveEffort && { effort: this.effectiveEffort }),
      ...(u.thoughtTokens && {
        thinking: { tokens: u.thoughtTokens, durationMs: this.thinkingMs },
      }),
      ...(stopped && { interrupted: true }),
    });
  }

  // busy clears before the terminal event: the workspace moves its queue on
  // it and checks isRunning.
  private endTurn(terminal?: StreamEvent): void {
    this.noteOwnTurn();
    this.busy = false;
    this.prompting = false;
    this.interruptRequested = false;
    this.usage.turns++;
    this.usage.duration_ms += Date.now() - this.turnStartedAt;
    this.thinkingMs = 0;
    if (terminal) this.emit("event", terminal);
    this.settleState();
    this.afterTurn();
  }

  private failTurn(content: string): void {
    this.flushThought();
    this.closeOpen("(stopped)");
    this.endTurn({ kind: "error", content });
  }

  // After every turn, the conversation as stored: what agy does later while
  // idle shows against it.
  private afterTurn(): void {
    this.shownWake = "";
    if (!this.client || !this.sessionId) return;
    void this.startLoad();
  }

  // What the turn streamed itself, for the load after it (not set by a turn
  // that never sent its prompt).
  private noteOwnTurn(): void {
    if (!this.promptSent) return;
    this.promptSent = false;
    this.ownTurn = { before: this.leftoverOwn, thought: this.leftoverThought, after: this.ownText };
  }

  // --- updates ---------------------------------------------------------------

  private onNotification(method: string, params: Obj): void {
    if (method !== "session/update") return;
    if (this.sessionId && params.sessionId !== this.sessionId) return;
    const u = params.update as SessionUpdate;
    if (u.sessionUpdate === "config_option_update") {
      this.noteConfig(u.configOptions);
      return;
    }
    if (u.sessionUpdate === "available_commands_update") {
      this.commands = new Set(u.availableCommands.map((c) => c.name));
      return;
    }
    if (this.replay) {
      this.replay.push(u);
      return;
    }
    if (this.prompting) this.onTurnUpdate(u);
  }

  private onTurnUpdate(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        if (!this.echoed) {
          this.echoed = true;
          // The reply to the prompt starts a paragraph of its own.
          if (this.leftoverShown) this.afterText = false;
        }
        break;
      case "agent_message_chunk": {
        const text = str(u.content?.text);
        if (this.leftover(text)) break;
        if (this.echoed) this.ownText += text;
        else this.leftoverOwn += text;
        this.text(text);
        break;
      }
      case "agent_thought_chunk":
        if (this.leftover(null)) break;
        if (!this.echoed) this.leftoverThought = true;
        this.thought(str(u.content?.text));
        break;
      case "tool_call":
      case "tool_call_update":
        this.toolCall(u);
        break;
      case "plan": {
        const lines = u.entries.map(
          (e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`,
        );
        if (lines.length) {
          this.emit("event", {
            kind: "notice",
            level: "info",
            content: `**Plan**\n${lines.join("\n")}`,
          });
        }
        break;
      }
      case "usage_update":
        if (u.used && u.size) this.context = { tokens: u.used, window: u.size };
        break;
      default:
        break;
    }
  }

  // Text agy streams before the prompt's echo is what it said while idle:
  // dropped while it repeats what loads showed, else shown here under a
  // banner. True: drop it.
  private leftover(text: string | null): boolean {
    if (this.echoed) return false;
    if (text !== null) this.leftoverText += text;
    if (this.shownWake) {
      if (text === null || this.shownWake.startsWith(this.leftoverText)) return true;
      this.shownWake = "";
    }
    if (!this.leftoverShown) {
      this.leftoverShown = true;
      this.emit("event", { kind: "notice", level: "wakeup", content: "agy carried on while idle" });
    }
    return false;
  }

  private text(delta: string): void {
    if (!delta) return;
    this.flushThought();
    let content = delta;
    // Text after a tool call or a thought is a new paragraph.
    if (this.textEmitted && !this.afterText) content = "\n\n" + content.trimStart();
    this.textEmitted = true;
    this.afterText = true;
    this.emit("event", { kind: "text_delta", content });
  }

  private thought(delta: string): void {
    if (!delta) return;
    if (!this.thinking) this.thinkingSince = Date.now();
    this.thinking += delta;
    this.afterText = false;
    this.emit("event", { kind: "thinking_delta", content: delta });
  }

  private flushThought(): void {
    const thought = this.thinking.trim();
    this.thinking = "";
    if (!thought) return;
    const durationMs = Date.now() - this.thinkingSince;
    this.thinkingMs += durationMs;
    this.emit("event", { kind: "thinking", content: thought, durationMs });
  }

  private toolCall(u: ToolCall): void {
    let call = this.calls.get(u.toolCallId);
    if (!call) {
      this.flushThought();
      this.afterText = false;
      const use = toolUse(u, this.panelToolNames());
      call = {
        startedAt: Date.now(),
        name: use.toolName ?? "tool",
        command: commandOf(u),
        background: false,
        done: false,
      };
      this.calls.set(u.toolCallId, call);
      this.emit("event", { ...use, toolUseId: u.toolCallId, startedAt: call.startedAt });
    }
    if (!call.done && (u.status === "completed" || u.status === "failed")) this.finish(u, call);
  }

  private finish(u: ToolCall, call: Call): void {
    call.done = true;
    const panel = /^mcp_panel_(.+)$/.exec(u.name ?? "");
    const key = panel && callKey(panel[1], u.args ?? u.rawInput);
    const at = key ? this.answers.findIndex((a) => a.key === key) : -1;
    const answer = at >= 0 ? this.answers.splice(at, 1)[0] : undefined;
    // Stop fails the running call, its output empty (agy/interrupt).
    const stopped = this.interruptRequested && u.status === "failed";
    const result: StreamEvent & { content: string } = stopped
      ? { kind: "tool_result", content: "Interrupted", isError: true }
      : answer && !u.content?.length
        ? { kind: "tool_result", content: answer.text, ...(answer.isError && { isError: true }) }
        : toolResult(u);
    const durationMs = Date.now() - call.startedAt;
    this.emit("event", { ...result, toolUseId: u.toolCallId, durationMs });
    if (!call.background) return;
    this.background.delete(u.toolCallId);
    this.emit("event", {
      kind: "subagent_done",
      content: result.content,
      toolUseId: u.toolCallId,
      subagent: {
        taskId: u.toolCallId,
        description: "",
        status: result.isError ? "failed" : "completed",
        durationMs,
        summary: tail(result.content),
      },
    });
    this.emit("backgroundTasks", this.backgroundTaskList);
  }

  // Commands still open when the turn ended run on in the background: each
  // gets a card, as Claude's do, and the session waits on them. Another
  // call left open stays so until a load shows it finished.
  private sendOpenToBackground(): void {
    let added = false;
    for (const [id, call] of this.calls) {
      if (call.done || call.background || !call.command) continue;
      call.background = true;
      added = true;
      const description = call.command ?? call.name;
      this.background.set(id, { id, type: "local_bash", description, since: call.startedAt });
      this.emit("event", {
        kind: "tool_result",
        content: "Running in the background.",
        toolUseId: id,
        durationMs: Date.now() - call.startedAt,
      });
      this.emit("event", {
        kind: "subagent_start",
        content: description,
        toolUseId: id,
        subagent: {
          taskId: id,
          description,
          ...(call.command && { prompt: fenced(call.command, "bash") }),
          agentType: "shell",
          taskType: "local_bash",
          status: "running",
          events: [],
        },
      });
    }
    if (added) this.emit("backgroundTasks", this.backgroundTaskList);
  }

  // The turn's open calls end with it; a panel answer for one of them is no
  // later call's.
  private closeOpen(content: string): void {
    this.answers = [];
    for (const [id, call] of this.calls) {
      if (call.done || call.background) continue;
      call.done = true;
      this.emit("event", {
        kind: "tool_result",
        content,
        toolUseId: id,
        isError: true,
        durationMs: Date.now() - call.startedAt,
      });
    }
  }

  // The process is gone, and every call it still ran with it.
  private stopCalls(): void {
    for (const [id, call] of this.calls) {
      if (call.done || call.background) continue;
      call.done = true;
      this.emit("event", {
        kind: "tool_result",
        content: "(stopped)",
        toolUseId: id,
        isError: true,
        durationMs: Date.now() - call.startedAt,
      });
    }
    if (!this.background.size) return;
    for (const id of this.background.keys()) {
      const call = this.calls.get(id);
      if (call) call.done = true;
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        toolUseId: id,
        subagent: {
          taskId: id,
          description: "",
          status: "stopped",
          ...(call && { durationMs: Date.now() - call.startedAt }),
        },
      });
    }
    this.background.clear();
    this.emit("backgroundTasks", []);
    this.settleState();
  }

  // --- while idle ------------------------------------------------------------

  private idleTimers(): boolean {
    return AgySession.hooks?.idleTimers !== false;
  }

  // agy's log, read from where it was last read: a model call while no
  // prompt runs means agy is at work by itself.
  private watchLog(): void {
    const file = this.logFile;
    if (!file || !this.idleTimers() || this.logWatch) return;
    try {
      this.logWatch = fs.watch(file, () => this.readLog());
      this.logWatch.on("error", () => {});
    } catch {
      this.logWatch = null;
    }
  }

  private readLog(): void {
    const file = this.logFile;
    if (!file) return;
    let added = "";
    try {
      const size = fs.statSync(file).size;
      if (size < this.logOffset) this.logOffset = 0;
      if (size === this.logOffset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - this.logOffset);
        fs.readSync(fd, buf, 0, buf.length, this.logOffset);
        added = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      this.logOffset = size;
    } catch {
      return;
    }
    if (this.busy || !MODEL_CALL.test(added)) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.checkIdle();
    }, IDLE_TIMINGS.settleMs);
  }

  private stopIdleTimers(): void {
    for (const t of [this.settleTimer, this.followUpTimer]) if (t) clearTimeout(t);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.settleTimer = this.followUpTimer = this.pollTimer = null;
  }

  private stopIdleWatch(): void {
    this.stopIdleTimers();
    this.logWatch?.close();
    this.logWatch = null;
  }

  // What agy did since the last load, if anything: shown as a turn of its
  // own, as a Claude wake-up is.
  checkIdle(): void {
    if (!this.client || !this.sessionId || this.busy || this.loading) return;
    AgySession.hooks?.onIdleCheck?.(this);
    void this.startLoad();
  }

  private startLoad(): Promise<void> {
    const loading: Promise<void> = this.load().finally(() => {
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  }

  // A load is not the turn's: a message sent meanwhile waits for it, and
  // what it found comes first in that message's reply.
  private async load(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const updates: SessionUpdate[] = [];
    this.replay = updates;
    try {
      await client.request("session/load", {
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...(await this.sessionParams()),
      });
    } catch {
      return;
    } finally {
      if (this.replay === updates) this.replay = null;
    }
    if (client !== this.client) return;
    const items = conversation(updates);
    const known = this.known;
    this.known = items;
    // Calls still open here that agy has finished, even before the load
    // after their turn (that one is the baseline for the rest).
    const completed: ToolCall[] = [];
    for (const i of items) {
      if (i.kind !== "tool" || !finished(i.call)) continue;
      const call = this.calls.get(i.call.toolCallId);
      if (call && !call.done) completed.push(i.call);
    }
    let fresh = known ? diff(known, items) : [];
    const own = this.ownTurn;
    if (own) {
      fresh = this.notOwn(fresh, own);
      this.ownTurn = null;
    }
    fresh = fresh.filter((i) => i.kind !== "tool" || !this.calls.has(i.call.toolCallId));
    this.dropGone(items);
    const said = fresh.some((i) => i.kind === "agent");
    const ended = completed.some((c) => this.calls.get(c.toolCallId)?.background);
    if (completed.length || fresh.length) this.showIdleWork(completed, fresh);
    else if (!this.busy) this.settleState();
    // agy answers a background command's end with a model call of its
    // own, which a load may come before.
    if (ended && !said) this.awaitReply = 6;
    else if (said) this.awaitReply = 0;
    const again = completed.length > 0 || fresh.length > 0 || this.awaitReply-- > 0;
    if (again && this.idleTimers()) {
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = null;
        this.checkIdle();
      }, IDLE_TIMINGS.followUpMs);
    }
  }

  // Of what the load after a turn has new, what is not the turn's own: its
  // prompt (the first new user message), the calls it streamed, its reply
  // (stored whole per message, in order), and text streamed before the
  // prompt's echo, shown then. A prompt agy stores no user message for (a
  // slash command) leaves only the reply to tell.
  private notOwn(fresh: Item[], turn: { before: string; thought: boolean; after: string }): Item[] {
    const out: Item[] = [];
    let prompt = !fresh.some((i) => i.kind === "user");
    const own = { before: turn.before, after: turn.after };
    for (const item of fresh) {
      if (item.kind === "tool") {
        if (!this.calls.has(item.call.toolCallId)) out.push(item);
        continue;
      }
      if (item.kind === "user" && !prompt) {
        prompt = true;
        continue;
      }
      if (item.kind === "user") {
        out.push(item);
        continue;
      }
      // Thoughts: the turn's own after its prompt, shown before it when it
      // streamed some there.
      if (item.kind === "thought") {
        if (!prompt && !turn.thought) out.push(item);
        continue;
      }
      const side = prompt ? "after" : "before";
      const left = own[side];
      if (left && left.startsWith(item.text)) own[side] = left.slice(item.text.length);
      else if (left && item.text.startsWith(left)) {
        own[side] = "";
        out.push({ kind: "agent", text: item.text.slice(left.length) });
      } else out.push(item);
    }
    return out;
  }

  // A background command a load no longer lists (a rewritten, compacted
  // conversation) is over as far as anything will tell.
  private dropGone(items: Item[]): void {
    const listed = new Set(items.flatMap((i) => (i.kind === "tool" ? [i.call.toolCallId] : [])));
    for (const id of [...this.background.keys()]) {
      if (listed.has(id)) continue;
      const call = this.calls.get(id);
      if (!call) continue;
      this.finish(
        {
          toolCallId: id,
          status: "failed",
          rawOutput: { output: "No longer in agy's conversation." },
        },
        call,
      );
    }
  }

  // A call agy finished closes where it was made; anything else agy did is
  // a turn of its own, or the start of the reply to a message waiting on
  // this load.
  private showIdleWork(completed: ToolCall[], fresh: Item[]): void {
    const ended: string[] = [];
    for (const u of completed) {
      const call = this.calls.get(u.toolCallId);
      if (!call || call.done) continue;
      if (call.background) ended.push(call.command ?? call.name);
      this.finish(u, call);
    }
    if (!fresh.some((i) => i.kind !== "user")) {
      this.settleState();
      return;
    }
    const inline = this.busy;
    if (!inline) {
      this.busy = true;
      this.resetTurn();
      this.setState("working");
    }
    const why = ended.length
      ? `${ended.map((c) => `\`${c}\``).join(", ")} finished`
      : "agy carried on by itself";
    this.emit("event", { kind: "notice", level: "wakeup", content: why });
    for (const item of fresh) {
      if (item.kind === "agent") {
        this.shownWake += item.text;
        this.text(item.text);
      } else if (item.kind === "thought") {
        this.thought(item.text);
        this.flushThought();
      } else if (item.kind === "tool") this.toolCall(item.call);
    }
    this.flushThought();
    this.sendOpenToBackground();
    if (inline) {
      this.afterText = false;
      return;
    }
    this.busy = false;
    this.emit("event", { kind: "result", content: "" });
    this.settleState();
  }

  private panelToolNames(): Set<string> {
    return new Set(this.panelTools?.tools.map((t) => t.name));
  }
}

// The replayed updates as the conversation's entries.
function conversation(updates: SessionUpdate[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, { kind: "tool"; call: ToolCall }>();
  for (const u of updates) {
    switch (u.sessionUpdate) {
      // A slash command's prompt comes as two: the command, the rest.
      case "user_message_chunk": {
        const last = items.at(-1);
        if (last?.kind === "user") last.text += str(u.content?.text);
        else items.push({ kind: "user", text: str(u.content?.text) });
        break;
      }
      case "agent_message_chunk":
        items.push({ kind: "agent", text: str(u.content?.text) });
        break;
      case "agent_thought_chunk":
        items.push({ kind: "thought", text: str(u.content?.text) });
        break;
      case "tool_call":
      case "tool_call_update": {
        const known = tools.get(u.toolCallId);
        if (known) known.call = { ...known.call, ...u };
        else {
          const item = { kind: "tool" as const, call: { ...u } };
          tools.set(u.toolCallId, item);
          items.push(item);
        }
        break;
      }
      default:
        break;
    }
  }
  return items;
}

const finished = (c: ToolCall) => c.status === "completed" || c.status === "failed";

// What the second of two loads of one conversation has that the first had
// not, in the second's order. Calls are matched by id, as a load lists a
// background command still running ahead of everything (agy/background);
// messages in order, the first's last one perhaps grown since (the rest of
// it). Messages that do not match are a rewritten conversation (compacted):
// nothing of it is new.
function diff(before: Item[], after: Item[]): Item[] {
  const calls = new Set<string>();
  const messages: Array<Extract<Item, { kind: "user" | "agent" | "thought" }>> = [];
  for (const b of before) {
    if (b.kind === "tool") calls.add(b.call.toolCallId);
    else messages.push(b);
  }
  const fresh: Item[] = [];
  let next = 0;
  for (const a of after) {
    if (a.kind === "tool") {
      if (!calls.has(a.call.toolCallId)) fresh.push(a);
      continue;
    }
    const b = messages[next++];
    if (!b) fresh.push(a);
    else if (b.kind !== a.kind || !a.text.startsWith(b.text)) return [];
    else if (next === messages.length && a.text.length > b.text.length) {
      fresh.push({ kind: a.kind, text: a.text.slice(b.text.length) });
    }
  }
  return fresh;
}

// A panel call as both its MCP request and agy's update name it; agy adds
// a toolSummary of its own to the arguments of both.
function callKey(tool: string, args: unknown): string {
  const { toolSummary: _, ...rest } = obj(args);
  return JSON.stringify([
    tool,
    Object.keys(rest)
      .sort()
      .map((k) => [k, rest[k]]),
  ]);
}

function tail(text: string, lines = 6): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function commandOf(u: ToolCall): string | undefined {
  const args = obj(u.args ?? u.rawInput);
  return u.name === "run_command" ? str(args.CommandLine) || undefined : undefined;
}

// agy's tools as the Claude tools they match, so they render alike; the
// rest by their own name and agy's title for the call. agy adds a
// toolSummary of its own to every call's arguments.
function toolUse(u: ToolCall, panel: Set<string>): StreamEvent {
  const { toolSummary: _, ...args } = obj(u.args ?? u.rawInput);
  const name = u.name ?? "";
  const claude = (toolName: string, input: Obj): StreamEvent => ({
    kind: "tool_use",
    toolName,
    content: formatToolUse({ name: toolName, input }),
  });
  switch (name) {
    case "run_command":
      return claude("Bash", { command: str(args.CommandLine) });
    case "write_file":
      return claude("Write", { file_path: str(args.Path), content: str(args.Content) });
    case "edit_file":
      return claude("Edit", {
        file_path: str(args.Path),
        old_string: str(args.Target),
        new_string: str(args.Replacement),
      });
    // A subagent agy runs on its own, in a conversation of its own that
    // streams nothing here; the call returns at once (agy/teamwork).
    case "invoke_subagent": {
      const role = [str(args.Role), str(args.TypeName) && `(${str(args.TypeName)})`];
      const prompt = str(args.Prompt);
      return {
        kind: "tool_use",
        toolName: "Agent",
        content: `**Agent** ${role.filter(Boolean).join(" ")}${prompt ? `\n\n> ${prompt.replace(/\n/g, "\n> ")}` : ""}`,
      };
    }
    // A background command's state, by its task id ("<conversation>/task-8").
    case "manage_task": {
      const task = str(args.TaskId).split("/").at(-1);
      return {
        kind: "tool_use",
        toolName: name,
        content: `**manage_task** ${str(args.Action)}${task ? ` \`${task}\`` : ""}`,
      };
    }
  }
  const mcp = /^mcp_panel_(.+)$/.exec(name);
  if (mcp && panel.has(mcp[1])) return claude(`mcp__panel__${mcp[1]}`, args);
  const label = name || u.kind || "tool";
  const title = u.title?.trim();
  return {
    kind: "tool_use",
    toolName: label,
    content: title && title !== label ? `**${label}** ${title}` : `**${label}**`,
  };
}

function toolResult(u: ToolCall): StreamEvent & { content: string } {
  const failed = u.status === "failed";
  const out = obj(u.rawOutput);
  const exit = typeof out.exit_code === "number" ? out.exit_code : 0;
  const error = (failed || exit !== 0) && { isError: true };
  if (u.name === "run_command" && typeof out.output === "string") {
    const status = exit !== 0 ? ` (exit code ${exit})` : "";
    return { kind: "tool_result", content: `${commandOutput(out.output)}${status}`, ...error };
  }
  if (u.name === "invoke_subagent" && !failed && !u.content?.length) {
    return { kind: "tool_result", content: "Started; agy goes on when it reports back." };
  }
  if (u.name === "write_file" || u.name === "edit_file") {
    return { kind: "tool_result", content: failed ? "failed" : "applied", ...error };
  }
  const texts = (u.content ?? [])
    .map((c) =>
      c.type === "content" ? str(c.content?.text) : c.type === "diff" ? diffText(c) : "",
    )
    .filter(Boolean);
  const diffs = (u.content ?? []).some((c) => c.type === "diff");
  if (diffs) {
    return {
      kind: "tool_result",
      content: fenced(texts.join("\n"), "diff"),
      isMarkdown: true,
      ...error,
    };
  }
  const body = str(out.output) || texts.join("\n") || (failed ? "failed" : "done");
  return { kind: "tool_result", content: body, ...error };
}

// run_command's report: "Created At: …\nCompleted At: …\nCommand exited
// with code 0.\n\nCommand output:\n<output>" (the times only on some), its
// output with the terminal's line ends.
function commandOutput(report: string): string {
  const at = report.indexOf("Command output:\n");
  const output = at >= 0 ? report.slice(at + "Command output:\n".length) : report;
  return output.replace(/\r\n/g, "\n").replace(/\n$/, "") || "(no output)";
}

function diffText(c: { path?: string; oldText?: string | null; newText?: string }): string {
  const old = (c.oldText ?? "").split("\n").map((l) => `- ${l}`);
  const neu = (c.newText ?? "").split("\n").map((l) => `+ ${l}`);
  return [`--- ${c.path ?? ""}`, ...(c.oldText ? old : []), ...neu].join("\n");
}
