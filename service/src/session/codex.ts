import { EventEmitter } from "events";
import * as os from "os";
import { z } from "zod";
import {
  ContextUsage,
  RunState,
  StreamEvent,
  UsageStats,
  SessionConfig,
  SessionState,
  fenced,
  formatToolUse,
} from "./claude";
import {
  AppServerClient,
  RpcRequestError,
  spawnAppServer,
  type CodexThread,
  type CodexTurn,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type RateLimitSnapshot,
  type RateLimitWindow,
  type ThreadItem,
  type ThreadTokenUsage,
  type Transport,
  type TurnError,
} from "./codex-rpc";
import type { PanelToolset } from "../project/tools";
import {
  codexContextWindow,
  codexFastTier,
  codexModelId,
  defaultEffortForModel,
} from "../config/presets";

// The panel's tools reach Codex as client-defined tools of this namespace,
// declared when the thread starts (the thread keeps them across resumes;
// snap fixture codex/resume) and answered here. A subagent's thread does not
// get them (codex/tools), so nothing needs refusing to subagents.
const PANEL_NAMESPACE = "panel";

// "no rollout found for thread id …" (codex 0.153): the thread is gone from
// ~/.codex/sessions.
const THREAD_GONE = /no rollout found|thread not found/i;

// A Codex session is one long-lived `codex app-server` (JSON-RPC over stdio,
// see codex-rpc.ts) holding one thread, started on the first message and
// resumed by thread id after a restart. A turn runs from turn/start to
// turn/completed; a message sent meanwhile is steered into it (turn/steer),
// and Stop is turn/interrupt, which leaves the process up. Frame facts are
// in the stream-debug skill; every case below has a recording in
// tests/snap/codex.
export class CodexSession extends EventEmitter {
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

  // Replaced by the tests: the connection a session opens (a recording
  // played back, an in-memory server) instead of a real app-server.
  static hooks: { transport?: (session: CodexSession) => Transport } | null = null;

  private client: AppServerClient | null = null;
  private connecting: Promise<AppServerClient> | null = null;
  // What the running process was started with; a change takes effect by
  // restarting it (the thread resumes) before the next turn.
  private launched: string | null = null;
  private panelTools: PanelToolset | null = null;

  private busy = false;
  // Every turn and every abort: what an older one's requests answer later
  // is no business of the current one.
  private generation = 0;
  private turnId: string | null = null;
  // Codex announced the turn (turn/started): it can be interrupted.
  private turnStarted = false;
  private turnStartedAt = 0;
  private interruptRequested = false;
  private interruptSent = false;
  // Steers waiting for the turn's id (turn/start not answered yet).
  private turnWaiters: Array<() => void> = [];
  // The turn's error (an `error` notification); turn/completed follows.
  private turnError: TurnError | null = null;
  // The turn was started with a prompt: its first userMessage item is that
  // prompt, any later one a message steered in.
  private awaitingPrompt = false;
  private steers: string[] = [];
  private textEmitted = false;
  private itemText = new Map<string, number>();
  private itemStartedAt = new Map<string, number>();
  private openTools = new Set<string>();
  private context: ContextUsage | undefined;
  private rateLimits: RateLimitSnapshot | null = null;
  // Codex repeats a warning on every turn (a model without metadata): each
  // is shown once.
  private warned = new Set<string>();
  // Subagent threads by id, as cards of the turn that spawned them.
  private subagents = new Map<
    string,
    { description: string; startedAt: number; lastText: string; done: boolean }
  >();

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.busy;
  }

  get runState(): RunState {
    return this.busy ? "working" : "idle";
  }

  get effectiveEffort(): string | null {
    return (
      this.config.effort ?? (this.config.model ? defaultEffortForModel(this.config.model) : null)
    );
  }

  get interruptPending(): boolean {
    return this.interruptRequested;
  }

  // Effort, model and Fast are turn/start parameters: they apply from the
  // next turn without touching the process.
  setEffort(level: string): void {
    this.config.effort = level;
  }

  setFastMode(on: boolean): void {
    this.config.fast = on || undefined;
  }

  setModel(model: string, effort: string | undefined, fast: boolean): void {
    this.config.model = model;
    this.config.effort = effort;
    this.config.fast = fast || undefined;
  }

  setGoal(goal: string | null): void {
    this.config.goal = goal ?? undefined;
  }

  setProviderEnv(env: Record<string, string> | undefined): void {
    this.config.providerEnv = env;
  }

  // Runtime only: the server sets them again on restore. A thread's tools
  // and instructions are fixed when it starts: codex keeps both in the
  // thread (its rollout) and resumes with them.
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
  }

  // What of the provider env is codex's: the server's carries other
  // backends' credentials too (a Claude login token), which neither belong
  // in codex's commands nor restart it when they change.
  private codexEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.config.providerEnv ?? {}).filter(([k]) => /^(OPENAI|CODEX)_/.test(k)),
    );
  }

  // The process's environment and the thread's resume parameters that only
  // a restart changes.
  private launchKey(): string {
    return JSON.stringify([
      this.codexEnv(),
      this.config.model ? codexContextWindow(this.config.model) : null,
    ]);
  }

  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env, ...this.codexEnv() };
    // codex reads an API key login from CODEX_API_KEY.
    if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;
    return env;
  }

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
    const key = this.launchKey();
    const transport =
      CodexSession.hooks?.transport?.(this) ??
      spawnAppServer({ cwd: this.config.cwd, env: this.env() });
    const client: AppServerClient = new AppServerClient(transport, {
      notification: (method, params) => {
        if (client === this.client) this.onNotification(method, params);
      },
      // A process being shut down calls no panel tool any more.
      request: (method, params) =>
        client === this.client
          ? this.onRequest(method, params)
          : Promise.reject(new Error("This session's app-server is shutting down.")),
      close: (reason) => this.onClose(client, reason),
    });
    this.client = client;
    try {
      await client.initialize();
      const threadId = await this.openThread(client);
      if (client !== this.client) throw new Error("The app-server was replaced while starting.");
      this.sessionId = threadId;
    } catch (e) {
      if (this.client === client) this.client = null;
      client.close();
      throw e;
    }
    this.launched = key;
    return client;
  }

  private threadParams(): Record<string, unknown> {
    const model = this.config.model;
    const window = model ? codexContextWindow(model) : null;
    return {
      cwd: this.config.cwd,
      ...(model && { model: codexModelId(model) }),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      serviceTier: this.serviceTier(),
      ...(window && { config: { model_context_window: window } }),
    };
  }

  private async openThread(client: AppServerClient): Promise<string> {
    if (this.sessionId) {
      try {
        await client.request("thread/resume", {
          threadId: this.sessionId,
          ...this.threadParams(),
          excludeTurns: true,
        });
        return this.sessionId;
      } catch (e) {
        if (!(e instanceof RpcRequestError) || !THREAD_GONE.test(e.message)) throw e;
        this.emit("event", {
          kind: "notice",
          level: "warning",
          content: `The Codex thread could not be resumed (${e.message}); this is a fresh thread without the earlier conversation.`,
        });
      }
    }
    const res = await client.request<{ thread: CodexThread }>("thread/start", {
      ...this.threadParams(),
      ...(this.panelTools && {
        developerInstructions: this.panelTools.instructions,
        dynamicTools: [this.panelNamespace(this.panelTools)],
      }),
    });
    return res.thread.id;
  }

  private panelNamespace(tools: PanelToolset): Record<string, unknown> {
    return {
      type: "namespace",
      name: PANEL_NAMESPACE,
      description: "The agent-team panel: its projects, sessions and board.",
      tools: tools.tools.map((t) => {
        const { $schema: _, ...schema } = z.toJSONSchema(z.object(t.shape));
        return { type: "function", name: t.name, description: t.description, inputSchema: schema };
      }),
    };
  }

  private serviceTier(): string {
    const tier = this.config.fast && this.config.model ? codexFastTier(this.config.model) : null;
    // Explicit either way: the user's config.toml may name a tier of its own.
    return tier ?? "default";
  }

  private turnParams(): Record<string, unknown> {
    const model = this.config.model;
    return {
      ...(model && { model: codexModelId(model) }),
      ...(this.config.effort && { effort: this.config.effort }),
      serviceTier: this.serviceTier(),
      // gpt-6 models default to no reasoning summary at all.
      summary: "detailed",
    };
  }

  async send(message: string): Promise<void> {
    if (this.busy) throw new Error("Session is busy");
    const compact = message.trim() === "/compact";
    this.beginTurn(!compact);
    // A turn stopped and replaced meanwhile: what this one's requests do
    // later is not the new turn's.
    const generation = this.generation;
    try {
      if (this.client && this.launched !== this.launchKey()) this.closeProcess();
      const client = await this.connect();
      if (generation !== this.generation) return;
      const threadId = this.sessionId;
      if (compact) {
        await client.request("thread/compact/start", { threadId });
      } else {
        const res = await client.request<{ turn: CodexTurn }>("turn/start", {
          threadId,
          input: [{ type: "text", text: message, text_elements: [] }],
          ...this.turnParams(),
        });
        if (generation === this.generation && !this.turnId && res.turn.status === "inProgress") {
          this.turnId = res.turn.id;
          this.releaseTurnWaiters();
        }
      }
    } catch (e) {
      if (generation === this.generation && this.busy) {
        this.failTurn(`[Codex error] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // A message for the running turn: false when there is none to take it
  // (it ended meanwhile, or it is one codex does not steer), and the
  // caller sends it as a turn of its own. Taken, it is the model's at its
  // next request: `steered` says when, `unread` at the turn's end that it
  // never came.
  async steer(message: string, inputId: string): Promise<boolean> {
    if (!this.busy || this.interruptRequested || message.trim() === "/compact") return false;
    const generation = this.generation;
    if (!this.turnId) await new Promise<void>((r) => this.turnWaiters.push(r));
    const client = this.client;
    const turnId = this.turnId;
    if (generation !== this.generation || !turnId || !client || this.interruptRequested) {
      return false;
    }
    // Before the request: its userMessage item can come before the answer.
    this.steers.push(inputId);
    try {
      await client.request("turn/steer", {
        threadId: this.sessionId,
        input: [{ type: "text", text: message, text_elements: [] }],
        expectedTurnId: turnId,
        clientUserMessageId: inputId,
      });
    } catch {
      const i = this.steers.indexOf(inputId);
      if (i >= 0) this.steers.splice(i, 1);
      return false;
    }
    return true;
  }

  // Stops the running turn; the process lives on. False when none runs.
  async interrupt(): Promise<boolean> {
    if (!this.busy) return false;
    this.interruptRequested = true;
    await this.sendInterrupt();
    return true;
  }

  // Only once codex started the turn (turn/started): before, there is no
  // turn of its to stop. A failed request leaves the turn running, and a
  // second Stop tries again.
  private async sendInterrupt(): Promise<void> {
    const client = this.client;
    if (!client || !this.turnStarted || !this.turnId || this.interruptSent) return;
    this.interruptSent = true;
    const generation = this.generation;
    try {
      await client.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
    } catch {
      if (generation !== this.generation) return;
      this.interruptSent = false;
      this.interruptRequested = false;
    }
  }

  private releaseTurnWaiters(): void {
    for (const release of this.turnWaiters.splice(0)) release();
  }

  // Ends the process. A turn it cuts off ends without a terminal event; the
  // workspace closes its message itself.
  abort(): void {
    this.generation++;
    this.closeProcess();
    if (this.busy) this.endTurn();
  }

  private closeProcess(): void {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.stopSubagents();
    client?.close();
  }

  private onClose(client: AppServerClient, reason: string): void {
    if (client !== this.client) return;
    this.client = null;
    this.stopSubagents();
    if (this.busy) this.failTurn(`[Codex error] ${reason}`);
  }

  private beginTurn(withPrompt: boolean): void {
    this.generation++;
    this.busy = true;
    this.turnId = null;
    this.turnStarted = false;
    this.turnStartedAt = Date.now();
    this.interruptRequested = false;
    this.interruptSent = false;
    this.turnError = null;
    this.awaitingPrompt = withPrompt;
    this.steers = [];
    this.textEmitted = false;
    this.itemText.clear();
    this.itemStartedAt.clear();
    this.openTools.clear();
    this.emit("runState", "working");
  }

  // busy clears before the terminal event: the workspace moves its queue
  // on that event and checks isRunning.
  private endTurn(terminal?: StreamEvent): void {
    this.busy = false;
    this.turnId = null;
    this.interruptRequested = false;
    this.usage.turns++;
    this.usage.duration_ms += Date.now() - this.turnStartedAt;
    this.releaseTurnWaiters();
    const unread = this.steers.splice(0);
    if (unread.length) this.emit("unread", unread);
    if (terminal) this.emit("event", terminal);
    this.emit("runState", "idle");
  }

  private failTurn(content: string): void {
    this.closeTools("(stopped)");
    this.endTurn({ kind: "error", content });
  }

  // Calls the turn left without a completion: an interrupted command gets
  // no item/completed (codex/interrupt).
  private closeTools(content: string): void {
    for (const id of this.openTools) {
      this.emit("event", { kind: "tool_result", content, toolUseId: id, isError: true });
    }
    this.openTools.clear();
  }

  // The process is gone, and the subagents it ran with it.
  private stopSubagents(): void {
    for (const [taskId, card] of this.subagents) {
      if (card.done) continue;
      card.done = true;
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        subagent: {
          taskId,
          description: card.description,
          status: "stopped",
          durationMs: Date.now() - card.startedAt,
        },
      });
    }
  }

  private completeTurn(turn: CodexTurn): void {
    if (!this.busy || (this.turnId && turn.id !== this.turnId)) return;
    if (turn.status === "interrupted") {
      this.closeTools("(interrupted)");
      this.endTurn(this.resultEvent(true));
      return;
    }
    if (turn.status === "failed") {
      const error = turn.error ?? this.turnError;
      this.closeTools("(stopped)");
      if (error?.codexErrorInfo === "usageLimitExceeded") {
        this.endTurn(this.refused(error));
        return;
      }
      this.endTurn({ kind: "error", content: `[Codex error] ${errorText(error?.message)}` });
      return;
    }
    this.closeTools("(no result)");
    this.endTurn(this.resultEvent(false));
  }

  private resultEvent(interrupted: boolean): StreamEvent {
    return {
      kind: "result",
      content: "",
      context: this.context,
      effort: this.effectiveEffort ?? undefined,
      ...(interrupted && { interrupted: true }),
    };
  }

  // A turn the usage limit refused (codex/usage-limit): the limit's window
  // and reset come in the account/rateLimits/updated sent just before.
  private refused(error: TurnError): StreamEvent {
    const spent = [this.rateLimits?.primary, this.rateLimits?.secondary]
      .filter((w): w is RateLimitWindow => !!w && w.usedPercent >= 100)
      .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    const rateLimitType = spent ? windowType(spent) : undefined;
    const resetsAt = spent?.resetsAt ?? undefined;
    this.emit("rateLimit", { rateLimitType, resetsAt });
    const label = rateLimitType ? ` (${rateLimitType.replace(/_/g, "-")})` : "";
    const reset = resetsAt ? ` Resets at ${new Date(resetsAt * 1000).toLocaleString()}.` : "";
    return {
      kind: "error",
      content: spent ? `Usage limit reached${label}.${reset}` : `[Codex error] ${error.message}`,
    };
  }

  private onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "item/tool/call")
      return this.callTool(params as unknown as DynamicToolCallParams);
    return Promise.reject(new Error(`agent-team does not answer ${method}`));
  }

  private async callTool(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const reply = (text: string, success: boolean): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success,
    });
    const tool =
      call.namespace === PANEL_NAMESPACE && call.threadId === this.sessionId
        ? this.panelTools?.tools.find((t) => t.name === call.tool)
        : undefined;
    if (!tool) return reply(`${call.tool} is not available to this session.`, false);
    const args = z.object(tool.shape).safeParse(call.arguments ?? {});
    if (!args.success) return reply(z.prettifyError(args.error), false);
    try {
      return reply(await tool.handler(args.data), true);
    } catch (e) {
      return reply(e instanceof Error ? e.message : String(e), false);
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = params.threadId as string | undefined;
    if (threadId && threadId !== this.sessionId) {
      this.onSubagentNotification(threadId, method, params);
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = params.turn as CodexTurn;
        if (!this.busy) {
          // A turn codex started itself (a goal carrying on).
          this.beginTurn(false);
          this.emit("event", { kind: "notice", level: "wakeup", content: "Codex carried on" });
        }
        this.turnId = turn.id;
        this.turnStarted = true;
        this.releaseTurnWaiters();
        if (this.interruptRequested) void this.sendInterrupt();
        break;
      }
      case "turn/completed":
        this.completeTurn(params.turn as CodexTurn);
        break;
      case "item/started":
        this.itemStarted(params.item as ThreadItem);
        break;
      case "item/completed":
        this.itemCompleted(params.item as ThreadItem);
        break;
      case "item/agentMessage/delta":
        this.text(params.itemId as string, params.delta as string);
        break;
      case "item/reasoning/summaryTextDelta":
        this.emit("event", { kind: "thinking_delta", content: params.delta as string });
        break;
      case "thread/tokenUsage/updated":
        this.noteTokens(params.tokenUsage as ThreadTokenUsage);
        break;
      case "account/rateLimits/updated":
        this.noteRateLimits(params.rateLimits as RateLimitSnapshot);
        break;
      case "error": {
        const error = params.error as TurnError;
        if (params.willRetry) this.emit("event", { kind: "retry", content: error.message });
        else this.turnError = error;
        break;
      }
      case "turn/plan/updated": {
        const plan = (params.plan as Array<{ step: string; status: string }>) ?? [];
        const lines = plan.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.step}`);
        if (lines.length) {
          this.emit("event", {
            kind: "notice",
            level: "info",
            content: `**Plan**\n${lines.join("\n")}`,
          });
        }
        break;
      }
      case "warning":
        if (threadId && !this.warned.has(params.message as string)) {
          this.warned.add(params.message as string);
          this.emit("event", {
            kind: "notice",
            level: "warning",
            content: `Codex: ${params.message as string}`,
          });
        }
        break;
    }
  }

  // Several agent messages in a turn are paragraphs of one reply.
  private text(itemId: string, delta: string): void {
    if (!delta) return;
    const sent = this.itemText.get(itemId);
    const lead = sent === undefined && this.textEmitted ? "\n\n" : "";
    this.itemText.set(itemId, (sent ?? 0) + delta.length);
    this.textEmitted = true;
    this.emit("event", { kind: "text_delta", content: lead + delta });
  }

  private toolUse(item: ThreadItem, toolName: string, content: string): void {
    this.openTools.add(item.id);
    this.itemStartedAt.set(item.id, Date.now());
    this.emit("event", { kind: "tool_use", toolName, content, toolUseId: item.id });
  }

  private toolResult(
    item: ThreadItem,
    content: string,
    isError = false,
    durationMs?: number | null,
  ): void {
    if (!this.openTools.delete(item.id)) return;
    const started = this.itemStartedAt.get(item.id);
    this.emit("event", {
      kind: "tool_result",
      content,
      toolUseId: item.id,
      ...(isError && { isError: true }),
      durationMs: durationMs ?? (started !== undefined ? Date.now() - started : undefined),
    });
  }

  private itemStarted(item: ThreadItem): void {
    switch (item.type) {
      case "userMessage": {
        if (this.awaitingPrompt) {
          this.awaitingPrompt = false;
          break;
        }
        // Tagged with the panel's id, or untagged and taken in order sent.
        const i = item.clientId ? this.steers.indexOf(item.clientId) : 0;
        const [inputId] = i >= 0 ? this.steers.splice(i, 1) : [];
        if (!inputId) break;
        // What follows answers the steered message: a reply of its own.
        this.textEmitted = false;
        this.emit("steered", inputId);
        break;
      }
      case "reasoning":
        this.itemStartedAt.set(item.id, Date.now());
        break;
      case "commandExecution":
        this.toolUse(item, "Bash", `**Bash**\n${fenced(commandText(item), "bash")}`);
        break;
      case "fileChange":
        this.toolUse(item, "Edit", `**Edit**\n${fenced(changeList(item.changes))}`);
        break;
      case "mcpToolCall":
        this.toolUse(item, "MCP", `**MCP** \`${item.server}.${item.tool}\``);
        break;
      case "dynamicToolCall": {
        const name = item.namespace === PANEL_NAMESPACE ? `mcp__panel__${item.tool}` : item.tool;
        const input = (item.arguments ?? {}) as Record<string, unknown>;
        this.toolUse(item, name, formatToolUse({ name, input }));
        break;
      }
      case "webSearch":
        this.toolUse(item, "WebSearch", `**WebSearch** ${item.query}`);
        break;
      case "imageView":
        this.toolUse(item, "ViewImage", `**ViewImage** \`${item.path}\``);
        break;
      case "collabAgentToolCall":
        this.toolUse(
          item,
          "Agent",
          `**Agent** ${item.tool}${item.prompt ? `\n\n> ${item.prompt}` : ""}`,
        );
        break;
      case "subAgentActivity":
        this.subagentActivity(item);
        break;
    }
  }

  private itemCompleted(item: ThreadItem): void {
    switch (item.type) {
      case "agentMessage": {
        // The text deltas did not carry: the rest of the item's text.
        const rest = item.text.slice(this.itemText.get(item.id) ?? 0);
        if (rest.trim()) this.text(item.id, rest);
        break;
      }
      case "reasoning": {
        const text = (item.summary.length ? item.summary : item.content).join("\n\n").trim();
        const started = this.itemStartedAt.get(item.id);
        if (text) {
          this.emit("event", {
            kind: "thinking",
            content: text,
            ...(started !== undefined && { durationMs: Date.now() - started }),
          });
        }
        break;
      }
      case "commandExecution": {
        const exit = item.exitCode ?? 0;
        const status = exit === 0 ? "" : ` (exit code ${exit})`;
        const output = item.aggregatedOutput ?? "";
        this.toolResult(
          item,
          `${output || (status ? "" : "(no output)")}${status}`,
          false,
          item.durationMs,
        );
        break;
      }
      case "fileChange":
        this.toolResult(
          item,
          item.status === "completed" ? "applied" : item.status,
          item.status !== "completed",
        );
        break;
      case "mcpToolCall":
        this.toolResult(
          item,
          item.error
            ? `Error: ${item.error.message}`
            : JSON.stringify(item.result?.structuredContent ?? item.result?.content ?? "done"),
          !!item.error,
          item.durationMs,
        );
        break;
      case "dynamicToolCall": {
        const text = (item.contentItems ?? []).map((c) => c.text ?? "").join("\n");
        this.toolResult(item, text, item.success === false, item.durationMs);
        break;
      }
      case "webSearch":
      case "imageView":
      case "collabAgentToolCall":
        this.toolResult(item, "done");
        break;
      case "contextCompaction":
        this.emit("event", { kind: "compact", content: "Context compacted" });
        break;
    }
  }

  // A subagent's card: its spawn starts it, its end ends it, and its
  // thread's items are the card's events. A subagent sent more work is the
  // same card going on.
  private subagentActivity(item: Extract<ThreadItem, { type: "subAgentActivity" }>): void {
    const taskId = item.agentThreadId;
    const description = item.agentPath.split("/").filter(Boolean).at(-1) ?? item.agentPath;
    const known = this.subagents.get(taskId);
    if (item.kind === "started" && !known) {
      this.subagents.set(taskId, { description, startedAt: Date.now(), lastText: "", done: false });
      this.emit("event", {
        kind: "subagent_start",
        content: description,
        subagent: {
          taskId,
          description,
          agentType: "subagent",
          taskType: "local_agent",
          status: "running",
          events: [],
        },
      });
    } else if ((item.kind === "completed" || item.kind === "interrupted") && known) {
      known.done = true;
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        subagent: {
          taskId,
          description,
          status: item.kind === "completed" ? "completed" : "stopped",
          durationMs: Date.now() - known.startedAt,
          ...(known.lastText && { summary: known.lastText }),
        },
      });
    }
  }

  private onSubagentNotification(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const card = this.subagents.get(threadId);
    if (!card) return;
    const inner = (event: StreamEvent) =>
      this.emit("event", {
        kind: "subagent_progress",
        content: "",
        subagent: { taskId: threadId, description: "", _innerEvent: event },
      });
    const item = params.item as ThreadItem | undefined;
    if (method === "item/completed" && item?.type === "agentMessage" && item.text.trim()) {
      card.lastText = item.text.trim();
      inner({ kind: "text", content: card.lastText });
    } else if (method === "item/started" && item?.type === "commandExecution") {
      inner({
        kind: "tool_use",
        toolName: "Bash",
        content: `**Bash**\n${fenced(commandText(item), "bash")}`,
        toolUseId: item.id,
      });
    } else if (method === "item/completed" && item?.type === "commandExecution") {
      inner({
        kind: "tool_result",
        content: item.aggregatedOutput || "(no output)",
        toolUseId: item.id,
      });
    }
  }

  // Context occupancy after each request: the last request's tokens less
  // its reasoning, which is not kept in context, over the effective window.
  private noteTokens(usage: ThreadTokenUsage): void {
    const last = usage.last;
    this.usage.input_tokens += last.inputTokens - last.cachedInputTokens;
    this.usage.output_tokens += last.outputTokens;
    this.usage.cache_read_tokens += last.cachedInputTokens;
    this.usage.cache_creation_tokens += last.cacheWriteInputTokens;
    if (usage.modelContextWindow) {
      this.context = {
        tokens: last.totalTokens - last.reasoningOutputTokens,
        window: usage.modelContextWindow,
      };
    }
  }

  // Updates are sparse: a missing window keeps the one seen last.
  private noteRateLimits(update: RateLimitSnapshot): void {
    this.rateLimits = {
      limitId: update.limitId ?? this.rateLimits?.limitId ?? null,
      primary: update.primary ?? this.rateLimits?.primary ?? null,
      secondary: update.secondary ?? this.rateLimits?.secondary ?? null,
      planType: update.planType ?? this.rateLimits?.planType ?? null,
    };
    this.emit("quota", this.rateLimits);
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

  async getUsageInfo(): Promise<Record<string, unknown> | null> {
    const limits = this.rateLimits ?? (await readCodexRateLimits(this.env()));
    if (!limits) return null;
    const rate_limits: Record<string, unknown> = {};
    for (const w of [limits.primary, limits.secondary]) {
      if (!w) continue;
      rate_limits[windowType(w)] = {
        utilization: w.usedPercent,
        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      };
    }
    return { rate_limits, ...(limits.planType && { subscription_type: limits.planType }) };
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      config: { ...this.config },
      usage: { ...this.usage },
    };
  }

  static fromState(state: SessionState): CodexSession {
    const session = new CodexSession(state.config);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }
}

// A backend error codex passes on as the response body: its message.
function errorText(message: string | undefined): string {
  if (!message) return "Turn failed";
  try {
    const body = JSON.parse(message) as { detail?: unknown; error?: { message?: unknown } };
    const text = body.detail ?? body.error?.message;
    if (typeof text === "string") return text;
  } catch {
    // plain text
  }
  return message;
}

// The panel's limit types: a window of up to a day is the short one.
function windowType(w: RateLimitWindow): "five_hour" | "seven_day" {
  return (w.windowDurationMins ?? 0) <= 24 * 60 ? "five_hour" : "seven_day";
}

// What the model ran, without the shell codex wraps it in.
function commandText(item: Extract<ThreadItem, { type: "commandExecution" }>): string {
  const actions = item.commandActions ?? [];
  if (actions.length === 1) return actions[0].command;
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc '(.*)'$/s.exec(item.command);
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : item.command;
}

function changeList(changes: Array<{ path: string; kind: { type: string } }>): string {
  const mark = (t: string) => (t === "add" ? "+" : t === "delete" ? "-" : "~");
  return changes.map((c) => `${mark(c.kind.type)} ${c.path}`).join("\n");
}

// The account's Codex limits without a turn: account/rateLimits/read on a
// short-lived app-server costs no quota. Null without a ChatGPT login.
export async function readCodexRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RateLimitSnapshot | null> {
  let client: AppServerClient | null = null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000).unref());
  const read = async () => {
    const transport = CodexSession.hooks?.transport
      ? null
      : spawnAppServer({ cwd: os.tmpdir(), env });
    if (!transport) return null;
    client = new AppServerClient(transport, {
      notification: () => {},
      request: () => Promise.reject(new Error("not answered")),
      close: () => {},
    });
    await client.initialize();
    const res = await client.request<{ rateLimits: RateLimitSnapshot }>(
      "account/rateLimits/read",
      null,
    );
    return res.rateLimits;
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch {
    return null;
  } finally {
    (client as AppServerClient | null)?.close();
  }
}
