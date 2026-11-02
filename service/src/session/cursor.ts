import { createHash } from "crypto";
import { EventEmitter } from "events";
import * as http from "http";
import { z } from "zod";
import type {
  AgentOptions,
  InteractionUpdate,
  Run,
  RunResult,
  SDKAgent,
  SDKCustomTool,
  SDKJsonValue,
} from "@cursor/sdk";
import {
  RunState,
  SessionConfig,
  SessionState,
  StreamEvent,
  UsageStats,
  fenced,
  formatToolUse,
} from "./claude";
import type { PanelToolset } from "../project/tools";
import { cursorModel, defaultEffortForModel } from "../config/presets";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// What the session uses of the SDK; the snap tests replace it with a player
// of recorded runs.
export interface CursorSdk {
  Agent: {
    create(options: AgentOptions): Promise<SDKAgent>;
    resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>;
  };
}

// The SDK runs in the server's own process, where fetch and https ignore
// HTTPS_PROXY unless told, and its HTTP/2 agent stream never uses a proxy:
// behind one, the agent talks HTTP/1.1 through the global proxy agents
// (setGlobalProxyFromEnv is Node 25.4+; before, NODE_USE_ENV_PROXY=1).
let proxied = false;
async function loadSdk(): Promise<CursorSdk> {
  if (CursorSession.sdk) return CursorSession.sdk;
  const sdk = await import("@cursor/sdk");
  if (!proxied && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
    if (typeof http.setGlobalProxyFromEnv === "function") http.setGlobalProxyFromEnv();
    sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
    proxied = true;
  }
  return sdk;
}

// What every agent runs with, recordings included (scripts/capture-sdk.ts):
// full access, as Claude and Codex agents have, and no question tool, which
// waits for an answer the panel has no way to give.
export const AGENT_DEFAULTS = {
  local: {
    settingSources: ["project", "user"],
    sandboxOptions: { enabled: false },
    autoReview: false,
  },
  disallowedTools: ["askQuestion"],
} satisfies Partial<AgentOptions>;

// A subagent's task call in flight: what its card has streamed so far.
interface Task {
  startedAt: number;
  text: string;
  thinking: string;
  reply: string;
  calls: Map<string, number>;
}

// Cursor agents through @cursor/sdk's local runtime: the agent loop runs in
// this process, files and shell on this machine, the model at Cursor. An
// agent persists in the SDK's store under its id (our sessionId) and is
// resumed by it; each message is one run. Events come from the run's
// onDelta updates (snap fixtures cursor/*): text and thinking deltas, tool
// calls started and completed with their typed payloads, a subagent's own
// steps nested in its task call, the turn's usage. run.stream() repeats the
// same as messages and is not read.
export class CursorSession extends EventEmitter {
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

  static sdk: CursorSdk | null = null;

  private agent: SDKAgent | null = null;
  private run: Run | null = null;
  private busy = false;
  // The send whose updates and end still count; abort() clears it, and a
  // later send replaces it, so a stopped run's late deltas go nowhere.
  private turn: object | null = null;
  // Close the agent once the running send has settled (abort, a new key).
  private closePending = false;
  private interruptRequested = false;
  private panelTools: PanelToolset | null = null;
  // Per run: calls not yet completed and when each started, subagents by
  // their task call, the thinking block streaming in, the reply's text.
  private openCalls = new Map<string, number>();
  private tasks = new Map<string, Task>();
  private thinking = "";
  private thinkingMs = 0;
  private reasoningTokens = 0;
  private textEmitted = false;
  private afterText = false;

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

  // Effort, fast mode and the model are the run's model selection, sent with
  // every message: a change applies from the next one.
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

  // Called for every session on any config reload or account switch: only a
  // changed key replaces the agent handle, and a running turn keeps its own.
  setProviderEnv(env: Record<string, string> | undefined): void {
    const changed = env?.CURSOR_API_KEY !== this.config.providerEnv?.CURSOR_API_KEY;
    this.config.providerEnv = env;
    if (!changed) return;
    if (this.busy) this.closePending = true;
    else this.closeAgent();
  }

  // Custom tools go with every run, so a changed set applies from the next.
  setPanelTools(tools: PanelToolset | null): void {
    this.panelTools = tools;
  }

  // The turn reports nothing more; its run is cancelled and the agent closed
  // once it has settled, which keeps the session busy until then.
  abort(): void {
    this.turn = null;
    this.interruptRequested = false;
    if (!this.busy) {
      this.closeAgent();
      return;
    }
    this.closePending = true;
    if (this.run) void this.run.cancel().catch(() => {});
  }

  // Cancels the run; the agent and its conversation stay. Asked while the
  // agent is still being created, nothing is sent.
  interrupt(): Promise<boolean> {
    if (!this.busy || !this.turn) return Promise.resolve(false);
    this.interruptRequested = true;
    if (this.run) void this.run.cancel().catch(() => {});
    return Promise.resolve(true);
  }

  getState(): SessionState {
    return { sessionId: this.sessionId, config: { ...this.config }, usage: { ...this.usage } };
  }

  static fromState(state: SessionState): CursorSession {
    const session = new CursorSession(state.config);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }

  // close() leaves its disposal's promises unobserved: one that rejected
  // would be an unhandled rejection, which ends the server.
  private closeAgent(): void {
    const agent = this.agent;
    this.agent = null;
    void agent?.[Symbol.asyncDispose]().catch(() => {});
  }

  private options(): AgentOptions {
    const apiKey = this.config.providerEnv?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
    if (!apiKey) throw new Error("No Cursor API key: set [cursor] api_key in config.toml.");
    return {
      ...AGENT_DEFAULTS,
      apiKey,
      model: this.model(),
      local: { ...AGENT_DEFAULTS.local, cwd: this.config.cwd },
    };
  }

  private model() {
    return cursorModel(
      this.config.model ?? "",
      this.effectiveEffort ?? undefined,
      this.config.fast,
    );
  }

  private async getAgent(): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    const sdk = await loadSdk();
    const options = this.options();
    if (this.sessionId) {
      try {
        this.agent = await sdk.Agent.resume(this.sessionId, options);
      } catch (e) {
        if ((e as Error).name !== "AgentNotFoundError") throw e;
        this.sessionId = null;
        throw new Error(
          `${(e as Error).message}\n\nThe stored Cursor agent could not be resumed; the next message will start a fresh conversation.`,
        );
      }
    } else {
      this.agent = await sdk.Agent.create(options);
      this.sessionId = this.agent.agentId;
    }
    return this.agent;
  }

  async send(message: string): Promise<void> {
    if (this.busy) throw new Error("Session is busy");
    this.busy = true;
    const turn = {};
    this.turn = turn;
    const live = () => this.turn === turn;
    this.emit("runState", "working");
    this.interruptRequested = false;
    this.openCalls.clear();
    this.tasks.clear();
    this.thinking = "";
    this.thinkingMs = 0;
    this.reasoningTokens = 0;
    this.textEmitted = false;
    this.afterText = false;
    const startTime = Date.now();
    let terminal: StreamEvent | null = null;
    try {
      const agent = await this.getAgent();
      if (!live() || this.interruptRequested) {
        terminal = { kind: "result", content: "", interrupted: true };
        return;
      }
      const instructions = this.panelTools?.instructions;
      const given = instructions && `${agent.agentId} ${hash(instructions)}`;
      const fresh = given && given !== this.config.panelInstructions ? instructions : undefined;
      // Cursor's custom tools carry no instructions of their own: they go
      // with the prompt, whenever they changed or the agent did.
      const prompt = fresh
        ? `<panel_instructions>\n${fresh}\n</panel_instructions>\n\n${message}`
        : message;
      const run = await agent.send(prompt, {
        model: this.model(),
        onDelta: ({ update }) => {
          if (live()) this.handleUpdate(update);
        },
        // force expires a run a previous server process left active in the
        // store (it went down mid-turn), which fails every send until then;
        // a run of ours is never active here, as one send runs at a time.
        local: { customTools: this.customTools(), force: true },
      });
      this.run = run;
      if (fresh) this.config.panelInstructions = given;
      if (!live() || this.interruptRequested) void run.cancel().catch(() => {});
      terminal = this.resultEvent(await run.wait());
    } catch (e) {
      terminal = errorEvent(e);
    } finally {
      this.run = null;
      this.busy = false;
      this.usage.turns++;
      this.usage.duration_ms += Date.now() - startTime;
      if (this.closePending) {
        this.closePending = false;
        this.closeAgent();
      }
      if (live()) {
        this.turn = null;
        this.closeOpenCalls();
        this.emit("event", terminal ?? { kind: "result", content: "" });
      }
      this.interruptRequested = false;
      this.emit("runState", "idle");
    }
  }

  // The panel's tools, run here in-process: the SDK serves them to the model
  // as the `custom-user-tools` MCP server, subagents included. It checks no
  // arguments and reports a thrown error as "Tool execution error" alone
  // (snap fixture cursor/custom-tool), so both happen here.
  private customTools(): Record<string, SDKCustomTool> | undefined {
    if (!this.panelTools) return undefined;
    const failed = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });
    return Object.fromEntries(
      this.panelTools.tools.map((t) => {
        const shape = z.object(t.shape);
        const { $schema: _, ...schema } = z.toJSONSchema(shape) as Obj;
        const tool: SDKCustomTool = {
          description: t.description,
          inputSchema: schema as Record<string, SDKJsonValue>,
          execute: async (args, context) => {
            // A subagent calls with a session id of its own.
            if (t.subagentRefusal && context.sessionId && context.sessionId !== this.sessionId) {
              return failed(t.subagentRefusal);
            }
            const parsed = shape.safeParse(args);
            if (!parsed.success) return failed(z.prettifyError(parsed.error));
            try {
              return await t.handler(parsed.data);
            } catch (e) {
              return failed(e instanceof Error ? e.message : String(e));
            }
          },
        };
        return [t.name, tool];
      }),
    );
  }

  private resultEvent(result: RunResult): StreamEvent {
    if (result.status === "cancelled") {
      return this.interruptRequested
        ? { kind: "result", content: "", interrupted: true }
        : { kind: "error", content: "[Cursor error] The run was cancelled." };
    }
    if (result.status === "error") {
      return errorEvent(result.error ?? { message: "The run failed." });
    }
    return {
      kind: "result",
      content: result.result?.trim() ?? "",
      ...(this.effectiveEffort && { effort: this.effectiveEffort }),
      ...(this.reasoningTokens > 0 && {
        thinking: { tokens: this.reasoningTokens, durationMs: this.thinkingMs },
      }),
    };
  }

  // A run that ends mid-thought or with calls still open (cancelled): keep
  // the thought, close the calls and their subagents' cards, or they read as
  // running forever.
  private closeOpenCalls(): void {
    const thought = this.thinking.trim();
    this.thinking = "";
    if (thought) this.emit("event", { kind: "thinking", content: thought });
    const closed = this.interruptRequested ? "Interrupted" : "No result";
    for (const [callId, task] of this.tasks) {
      for (const [id, at] of task.calls) {
        this.emitInner(callId, {
          kind: "tool_result",
          content: closed,
          toolUseId: id,
          isError: true,
          durationMs: Date.now() - at,
        });
      }
      this.emit("event", {
        kind: "subagent_done",
        content: "",
        toolUseId: callId,
        subagent: {
          taskId: callId,
          description: "",
          status: "stopped",
          durationMs: Date.now() - task.startedAt,
        },
      });
    }
    this.tasks.clear();
    for (const [callId, at] of this.openCalls) {
      this.emit("event", {
        kind: "tool_result",
        content: closed,
        toolUseId: callId,
        isError: true,
        durationMs: Date.now() - at,
      });
    }
    this.openCalls.clear();
  }

  private handleUpdate(update: InteractionUpdate): void {
    const u = update as Obj;
    switch (u.type) {
      case "text-delta": {
        let content = text(u.text);
        if (!content) break;
        // Text after a tool call or thought is a new paragraph; deltas within
        // one are concatenated verbatim.
        if (this.textEmitted && !this.afterText) content = "\n\n" + content.trimStart();
        this.textEmitted = true;
        this.afterText = true;
        this.emit("event", { kind: "text_delta", content });
        break;
      }
      case "thinking-delta": {
        const delta = text(u.text);
        if (!delta) break;
        this.thinking += delta;
        this.afterText = false;
        this.emit("event", { kind: "thinking_delta", content: delta });
        break;
      }
      case "thinking-completed": {
        const durationMs = num(u.thinkingDurationMs) || undefined;
        if (durationMs) this.thinkingMs += durationMs;
        const thought = this.thinking.trim();
        this.thinking = "";
        this.afterText = false;
        this.emit(
          "event",
          thought
            ? { kind: "thinking", content: thought, durationMs }
            : { kind: "thinking_delta", content: "", durationMs },
        );
        break;
      }
      case "tool-call-started": {
        const callId = text(u.callId);
        if (!callId || this.openCalls.has(callId)) break;
        const call = obj(u.toolCall);
        this.openCalls.set(callId, Date.now());
        this.afterText = false;
        this.emit("event", { ...toolUse(call, this.panelToolNames()), toolUseId: callId });
        if (call.type === "task") this.startTask(callId, obj(call.args));
        break;
      }
      case "tool-call-delta": {
        const callId = text(u.callId);
        const task = this.tasks.get(callId);
        if (task) this.handleTaskUpdate(callId, task, obj(u.taskUpdate));
        break;
      }
      case "tool-call-completed": {
        const callId = text(u.callId);
        const at = this.openCalls.get(callId);
        if (at == null) break;
        this.openCalls.delete(callId);
        const call = obj(u.toolCall);
        const task = this.tasks.get(callId);
        if (task) {
          this.endTask(callId, task, call, Date.now() - at);
          break;
        }
        this.emit("event", {
          ...toolResult(call),
          toolUseId: callId,
          durationMs: Date.now() - at,
        });
        break;
      }
      case "turn-ended": {
        const usage = obj(u.usage);
        const n = (k: string) => num(usage[k]);
        // Input includes what was read from the cache (totalTokens is input
        // plus output in the recordings, cacheRead apart).
        this.usage.input_tokens += n("inputTokens") - n("cacheReadTokens");
        this.usage.output_tokens += n("outputTokens");
        this.usage.cache_read_tokens += n("cacheReadTokens");
        this.usage.cache_creation_tokens += n("cacheWriteTokens");
        this.reasoningTokens += n("reasoningTokens");
        break;
      }
      default:
        break;
    }
  }

  // A subagent gets a card of its own, as Claude's agents do; its steps
  // arrive one level deep in tool-call-delta updates (cursor/subagent).
  private startTask(callId: string, args: Obj): void {
    const description = text(args.description);
    // A custom subagent by its name, a built-in one by its kind (explore,
    // shell, browser_use, ...).
    const type = obj(args.subagentType);
    const kind = text(type.kind);
    this.tasks.set(callId, {
      startedAt: Date.now(),
      text: "",
      thinking: "",
      reply: "",
      calls: new Map(),
    });
    this.emit("event", {
      kind: "subagent_start",
      content: description,
      toolUseId: callId,
      subagent: {
        taskId: callId,
        description,
        prompt: text(args.prompt) || undefined,
        agentType: text(type.name) || (kind && kind !== "unspecified" ? kind : "subagent"),
        taskType: "local_agent",
        status: "running",
        events: [],
      },
    });
  }

  private emitInner(callId: string, inner: StreamEvent): void {
    this.emit("event", {
      kind: "subagent_progress",
      content: "",
      toolUseId: callId,
      subagent: { taskId: callId, description: "", _innerEvent: inner },
    });
  }

  // A subagent's text is shown per block, as Claude's are.
  private flushTaskText(callId: string, task: Task): void {
    const block = task.text.trim();
    task.text = "";
    if (!block) return;
    task.reply = block;
    this.emitInner(callId, { kind: "text", content: block });
  }

  private handleTaskUpdate(callId: string, task: Task, u: Obj): void {
    switch (u.type) {
      case "text-delta":
        task.text += text(u.text);
        break;
      case "thinking-delta":
        this.flushTaskText(callId, task);
        task.thinking += text(u.text);
        break;
      case "thinking-completed": {
        this.flushTaskText(callId, task);
        const thought = task.thinking.trim();
        task.thinking = "";
        if (thought) {
          this.emitInner(callId, {
            kind: "thinking",
            content: thought,
            durationMs: num(u.thinkingDurationMs) || undefined,
          });
        }
        break;
      }
      case "tool-call-started": {
        const id = text(u.callId);
        if (!id || task.calls.has(id)) break;
        this.flushTaskText(callId, task);
        task.calls.set(id, Date.now());
        this.emitInner(callId, {
          ...toolUse(obj(u.toolCall), this.panelToolNames()),
          toolUseId: id,
        });
        break;
      }
      case "tool-call-completed": {
        const id = text(u.callId);
        const at = task.calls.get(id);
        if (at == null) break;
        task.calls.delete(id);
        this.emitInner(callId, {
          ...toolResult(obj(u.toolCall)),
          toolUseId: id,
          durationMs: Date.now() - at,
        });
        break;
      }
      case "step-completed":
        this.flushTaskText(callId, task);
        break;
      default:
        break;
    }
  }

  // The task call's result is the subagent's last text block, as the report
  // an Agent call returns; the card closes with it.
  private endTask(callId: string, task: Task, call: Obj, durationMs: number): void {
    this.flushTaskText(callId, task);
    this.tasks.delete(callId);
    const result = obj(call.result);
    const failed = result.status === "error";
    const background = obj(result.value).isBackground === true;
    const report = failed
      ? text(obj(result.error).message) || "The subagent failed."
      : task.reply ||
        (background ? "Running in the background; it reports back in a later turn." : "done");
    this.emit("event", {
      kind: "tool_result",
      content: report,
      toolUseId: callId,
      isMarkdown: true,
      ...(failed && { isError: true }),
      durationMs,
    });
    this.emit("event", {
      kind: "subagent_done",
      content: report,
      toolUseId: callId,
      subagent: {
        taskId: callId,
        description: "",
        status: failed ? "failed" : "completed",
        durationMs,
        summary: report,
      },
    });
  }

  private panelToolNames(): Set<string> {
    return new Set(this.panelTools?.tools.map((t) => t.name));
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function errorEvent(e: unknown): StreamEvent {
  const err = obj(e);
  const message = text(err.message) || String(e);
  const name = text(err.name);
  const code = text(err.code);
  if (name === "RateLimitError" || /rate.?limit|usage.?limit/i.test(code)) {
    return { kind: "error", content: `Cursor usage limit: ${message}` };
  }
  if (name === "AuthenticationError") {
    return {
      kind: "error",
      content: `[Cursor error] ${message}\n\nCheck [cursor] api_key in config.toml.`,
    };
  }
  return { kind: "error", content: `[Cursor error] ${message}` };
}

// Cursor's tools as the Claude tools they match, so they render alike; the
// rest by their own name. Payloads are the SDK's (marked unstable): read
// defensively.
function toolUse(call: Obj, panel: Set<string>): StreamEvent {
  const args = obj(call.args);
  const type = text(call.type);
  const claude = (name: string, input: Obj): StreamEvent => ({
    kind: "tool_use",
    toolName: name,
    content: formatToolUse({ name, input }),
  });
  const own = (name: string, body?: string): StreamEvent => ({
    kind: "tool_use",
    toolName: name,
    content: body ? `**${name}** ${body}` : `**${name}**`,
  });
  switch (type) {
    case "shell":
      return claude("Bash", { command: text(args.command) });
    case "read":
      return claude("Read", { file_path: text(args.path) });
    case "write":
      return claude("Write", { file_path: text(args.path), content: text(args.fileText) });
    case "edit":
      return own("Edit", `\`${text(args.path)}\``);
    case "delete":
      return own("Delete", `\`${text(args.path)}\``);
    case "glob": {
      const dir = text(args.targetDirectory);
      return own("Glob", `\`${text(args.globPattern)}\`${dir ? ` in \`${dir}\`` : ""}`);
    }
    case "grep":
      return claude("Grep", { pattern: text(args.pattern), path: args.path });
    case "ls":
      return own("LS", `\`${text(args.path)}\``);
    case "semSearch":
      return own("SemanticSearch", text(args.query));
    case "task":
      return claude("Agent", { prompt: text(args.prompt) || text(args.description) });
    case "updateTodos": {
      const todos = Array.isArray(args.todos) ? args.todos.map(obj) : [];
      const lines = todos.map(
        (t) => `- [${t.status === "completed" ? "x" : " "}] ${text(t.content)}`,
      );
      return { kind: "tool_use", toolName: "Todos", content: `**Todos**\n${lines.join("\n")}` };
    }
    case "createPlan":
      return { kind: "tool_use", toolName: "Plan", content: `**Plan**\n\n${text(args.plan)}` };
    case "mcp": {
      const tool = text(args.toolName);
      const input = obj(args.args);
      const name =
        text(args.providerIdentifier) === "custom-user-tools" && panel.has(tool)
          ? `mcp__panel__${tool}`
          : `mcp__${text(args.providerIdentifier) || "mcp"}__${tool}`;
      return claude(name, input);
    }
    default:
      return claude(type || "tool", args);
  }
}

function toolResult(call: Obj): StreamEvent {
  const result = obj(call.result);
  if (result.status === "error") {
    const error = obj(result.error);
    return {
      kind: "tool_result",
      content: text(error.message) || JSON.stringify(result.error),
      isError: true,
    };
  }
  const v = obj(result.value);
  switch (text(call.type)) {
    case "shell": {
      const output = [text(v.stdout), text(v.stderr)].filter(Boolean).join("\n");
      const failed = typeof v.exitCode === "number" && v.exitCode !== 0;
      const status = failed ? ` (exit code ${String(v.exitCode)})` : "";
      return {
        kind: "tool_result",
        content: `${output || (failed ? "" : "(no output)")}${status}`,
        ...(failed && { isError: true }),
      };
    }
    case "read":
      return {
        kind: "tool_result",
        content: text(v.content) || `(no text, ${num(v.fileSize)} bytes)`,
      };
    case "edit": {
      const diff = text(v.diffString);
      return diff
        ? { kind: "tool_result", content: fenced(diff, "diff"), isMarkdown: true }
        : {
            kind: "tool_result",
            content: `+${num(v.linesAdded)} −${num(v.linesRemoved)}`,
          };
    }
    case "write":
      return { kind: "tool_result", content: `${num(v.linesCreated)} lines written` };
    case "delete":
      return { kind: "tool_result", content: "Deleted" };
    case "updateTodos":
      return { kind: "tool_result", content: `${num(v.totalCount)} todos` };
    case "glob":
      return { kind: "tool_result", content: list(v.files) };
    case "grep":
      return { kind: "tool_result", content: grepText(v) };
    case "mcp": {
      const items = Array.isArray(v.content) ? v.content.map(obj) : [];
      const body = items
        .map((c) => (c.text ? text(obj(c.text).text) : c.image ? "[image]" : ""))
        .filter(Boolean)
        .join("\n");
      return {
        kind: "tool_result",
        content: body || "(no output)",
        ...(v.isError === true && { isError: true }),
      };
    }
    case "semSearch":
      return { kind: "tool_result", content: text(v.results) };
    case "task":
      return { kind: "tool_result", content: text(v.resultSuffix) || "done", isMarkdown: true };
    default:
      return { kind: "tool_result", content: Object.keys(v).length ? JSON.stringify(v) : "done" };
  }
}

function list(v: unknown): string {
  const items = Array.isArray(v) ? v.map(String) : [];
  return items.length ? items.join("\n") : "(none)";
}

function grepText(v: Obj): string {
  const lines: string[] = [];
  for (const [root, r] of Object.entries(obj(v.workspaceResults))) {
    const out = obj(obj(r).output);
    if (Array.isArray(out.matches)) {
      // Matches can come without their line (cursor/local-tools).
      for (const m of out.matches.map(obj)) {
        const at = num(m.lineNumber) ? `:${num(m.lineNumber)}` : "";
        lines.push(`${text(m.file) || root}${at}${m.line != null ? `:${text(m.line)}` : ""}`);
      }
    } else if (Array.isArray(out.files)) {
      lines.push(...out.files.map(String));
    } else if (Array.isArray(out.counts)) {
      lines.push(...out.counts.map(obj).map((c) => `${text(c.file)}:${String(c.count)}`));
    }
  }
  return lines.length ? lines.join("\n") : "(no matches)";
}
