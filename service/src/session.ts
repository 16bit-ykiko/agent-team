import { EventEmitter } from "events";
import { supportsAdaptiveThinking } from "./presets";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  Options,
  EffortLevel,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

export interface ToolInput {
  tool: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export type StreamEventKind =
  | "thinking"
  | "thinking_delta"
  | "text"
  | "text_delta"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "subagent_start"
  | "subagent_progress"
  | "subagent_done"
  | "compact"
  // One-line banner from the CLI loop: hook feedback, notifications,
  // permission denials, compact failures, auth prompts.
  | "notice"
  // API retry in progress; replaces the previous retry event of the turn.
  | "retry";

export type NoticeLevel = "info" | "notice" | "warning" | "error";

export interface StreamEvent {
  kind: StreamEventKind;
  content: string;
  // Tool name for tool_use events (the content is the formatted markdown).
  toolName?: string;
  level?: NoticeLevel;
  toolInput?: ToolInput;
  step?: number;
  contentOffset?: number;
  toolUseId?: string;
  isMarkdown?: boolean;
  toolResult?: string;
  toolResultIsMarkdown?: boolean;
  subagent?: SubAgentInfo;
}

export interface SubAgentInfo {
  taskId: string;
  description: string;
  prompt?: string;
  agentType?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  lastTool?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  summary?: string;
  eventCount?: number;
  events?: StreamEvent[];
  _innerEvent?: StreamEvent;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  turns: number;
  duration_ms: number;
}

export interface SessionConfig {
  cwd: string;
  backend?: "claude" | "codex";
  model?: string;
  effort?: string;
  permissionMode?: string;
  systemPrompt?: string;
  providerEnv?: Record<string, string>;
}

export interface SessionState {
  sessionId: string | null;
  config: SessionConfig;
  usage: UsageStats;
}

const DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "Monitor",
  "TaskOutput",
  "TaskStop",
  "CronCreate",
  "CronDelete",
  "CronList",
];

type InputController = {
  push(msg: SDKUserMessage): void;
  end(): void;
};

function createInputStream(): {
  iterable: AsyncIterable<SDKUserMessage>;
  controller: InputController;
} {
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  const buffer: SDKUserMessage[] = [];
  let done = false;

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };

  const controller: InputController = {
    push(msg) {
      if (done) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        buffer.push(msg);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as unknown as SDKUserMessage, done: true });
      }
    },
  };

  return { iterable, controller };
}

export class ClaudeSession extends EventEmitter {
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

  private queryInstance: Query | null = null;
  private inputController: InputController | null = null;
  private abortController: AbortController | null = null;
  private iterating = false;
  private processing = false;
  private turnStartTime = 0;
  private stepCounter = 0;
  // Subagent parent-child tracking: SDK only gives us flat task events, so we
  // reconstruct the hierarchy from tool_use IDs to route nested events correctly.
  private subagentToolMap = new Map<string, string>(); // toolUseId → taskId
  private nestedToolUseToParent = new Map<string, string>(); // inner toolUseId → parentTaskId
  private nestedTaskToParent = new Map<string, string>(); // nested taskId → parentTaskId
  private taskToToolUse = new Map<string, string>(); // taskId → toolUseId (reverse lookup)
  private agentTaskIds = new Set<string>();
  // Subagent output can arrive before its task_started (the CLI forwards
  // assistant blocks with parent_tool_use_id as soon as the Task tool runs).
  // Park those until the task registers, instead of dropping them.
  private pendingNested = new Map<string, StreamEvent[]>();
  private lastRateLimitStatus: string | null = null;
  private intentionalAbort = false;
  private activity: string | null = null;
  private unhandledSeen = new Set<string>();

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.processing;
  }

  async send(message: string): Promise<void> {
    this.intentionalAbort = false;
    if (!this.queryInstance) {
      await this.startQuery(message);
    } else {
      this.pushMessage(message);
    }
  }

  private async startQuery(message: string): Promise<void> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const { iterable, controller } = createInputStream();
    this.inputController = controller;
    this.abortController = new AbortController();

    const options = this.buildOptions();

    this.queryInstance = query({
      prompt: iterable,
      options,
    });

    this.startIterating();
    this.pushMessage(message);

    this.queryInstance!.supportedCommands()
      .then((cmds) => {
        const commands: CommandInfo[] = cmds.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        }));
        this.emit("commands", commands);
      })
      .catch(() => {});
  }

  private pushMessage(message: string): void {
    // Rate-limit dedupe is per turn: a fresh user message must be able to
    // report its own rejection even when the previous turn was rejected too
    // (a session-lifetime dedupe swallowed the second turn's error entirely).
    this.lastRateLimitStatus = null;
    const userMsg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    };
    this.inputController!.push(userMsg);
    this.processing = true;
    this.turnStartTime = Date.now();
    this.stepCounter = 0;
  }

  private startIterating(): void {
    if (this.iterating) return;
    this.iterating = true;

    const thisQuery = this.queryInstance;

    (async () => {
      try {
        for await (const msg of thisQuery!) {
          this.handleSDKMessage(msg);
        }
      } catch (err) {
        if (this.queryInstance !== thisQuery) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        // Suppress the error bubble ONLY for aborts WE initiated (user Stop,
        // credential swaps). Matching /abort/i on any error was a disaster:
        // network failures throw "This operation was aborted" and every one
        // of them rendered as a silent empty reply.
        if (!this.intentionalAbort) {
          this.emit("event", { kind: "error", content: `[Claude error] ${errMsg}` } as StreamEvent);
        }
      } finally {
        if (this.queryInstance === thisQuery) {
          if (this.processing) {
            this.emit("event", { kind: "result", content: "" } as StreamEvent);
          }
          this.iterating = false;
          this.processing = false;
          this.queryInstance = null;
          this.inputController = null;
          this.abortController = null;
          this.setActivity(null);
        }
      }
    })();
  }

  private setProcessing(): void {
    if (!this.processing) {
      this.processing = true;
      this.turnStartTime = Date.now();
    }
  }

  // Swap credentials/env for this session. The env is baked into the SDK
  // child process at query start, so if a query is alive and idle we abort it
  // — the next send() starts a fresh query that resumes the same session id
  // (session transcripts are local files, valid across accounts).
  setProviderEnv(env: Record<string, string> | undefined): void {
    this.config.providerEnv = env;
    if (this.queryInstance && !this.processing) {
      this.intentionalAbort = true;
      this.abortController?.abort();
    }
  }

  private handleRateLimitInfo(info: Record<string, unknown>): void {
    const status = info.status as string;
    if (status === this.lastRateLimitStatus) return;
    this.lastRateLimitStatus = status;
    if (status !== "rejected") return;
    this.emit("rateLimit", {
      rateLimitType: info.rateLimitType as string | undefined,
      resetsAt: info.resetsAt as number | undefined,
    });
    const kind = (info.rateLimitType as string) ?? "usage";
    const label = kind.replace(/_/g, "-");
    const resetsAt = info.resetsAt as number | undefined;
    const resetStr = resetsAt ? ` Resets at ${new Date(resetsAt * 1000).toLocaleString()}.` : "";
    this.emit("event", {
      kind: "error",
      content: `Usage limit reached (${label}).${resetStr}`,
    } as StreamEvent);
  }

  // Debug-only (gated behind AGENT_TEAM_DEBUG on the server): inject the
  // exact rejection the SDK would emit, to exercise the recovery pipeline
  // end-to-end without burning a real quota window.
  simulateRateLimit(info: { rateLimitType?: string; resetsAt?: number }): void {
    this.handleRateLimitInfo({ status: "rejected", ...info });
  }

  // Stop a running subagent task. The SDK emits a task_notification with
  // status "stopped", which flows back through the normal event pipeline.
  async stopTask(taskId: string): Promise<void> {
    if (!this.queryInstance) throw new Error("No active session");
    await this.queryInstance.stopTask(taskId);
  }

  private cleanupTask(taskId: string): void {
    this.agentTaskIds.delete(taskId);
    this.nestedTaskToParent.delete(taskId);
    const toolUseId = this.taskToToolUse.get(taskId);
    if (toolUseId) {
      this.taskToToolUse.delete(taskId);
      this.subagentToolMap.delete(toolUseId);
      this.nestedToolUseToParent.delete(toolUseId);
    }
  }

  private clearTrackingState(): void {
    this.subagentToolMap.clear();
    this.nestedToolUseToParent.clear();
    this.nestedTaskToParent.clear();
    this.taskToToolUse.clear();
    this.agentTaskIds.clear();
    this.pendingNested.clear();
    this.setActivity(null);
  }

  // Transient "what is the agent doing right now" label (compacting, a long
  // tool call, a hook...). Null clears it. Emitted only on change.
  private setActivity(activity: string | null): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.emit("activity", activity);
  }

  // Messages we deliberately do not render. Everything else that falls
  // through is reported on the "unhandled" channel so it shows up in the
  // logs instead of vanishing.
  private static readonly SILENT_TYPES = new Set([
    "keep_alive",
    "tool_use_summary",
    "prompt_suggestion",
    "control_request",
    "control_response",
    "control_cancel_request",
  ]);
  private static readonly SILENT_SYSTEM_SUBTYPES = new Set([
    "init",
    "background_tasks_changed",
    "task_updated",
    "hook_progress",
  ]);

  private reportUnhandled(msg: SDKMessage): void {
    const m = msg as unknown as Record<string, unknown>;
    const key = `${m.type}${m.subtype ? "/" + m.subtype : ""}`;
    if (!this.unhandledSeen.has(key)) {
      this.unhandledSeen.add(key);
      console.warn(`[session] unhandled SDK message: ${key}`);
    }
    this.emit("unhandled", msg);
  }

  private emitNestedEvent(parentTaskId: string, innerEvent: StreamEvent): void {
    const parentToolUseId = this.taskToToolUse.get(parentTaskId);
    this.emit("event", {
      kind: "subagent_progress",
      content: "",
      toolUseId: parentToolUseId,
      subagent: { taskId: parentTaskId, description: "", _innerEvent: innerEvent },
    } as StreamEvent);
  }

  private emitInner(parentToolUseId: string, taskId: string, inner: StreamEvent): void {
    this.emit("event", {
      kind: "subagent_progress",
      content: "",
      toolUseId: parentToolUseId,
      subagent: { taskId, description: "", _innerEvent: inner },
    } as StreamEvent);
  }

  private static readonly MAX_PARKED = 200;
  private parkNested(parentToolUseId: string, inner: StreamEvent): void {
    const list = this.pendingNested.get(parentToolUseId) ?? [];
    if (list.length < ClaudeSession.MAX_PARKED) list.push(inner);
    this.pendingNested.set(parentToolUseId, list);
  }

  private handleSDKMessage(msg: SDKMessage): void {
    if ("session_id" in msg && msg.session_id) {
      this.sessionId = msg.session_id;
    }

    switch (msg.type) {
      case "assistant":
        this.setProcessing();
        this.handleAssistantMessage(msg as SDKAssistantMessage);
        break;

      case "user":
        this.handleUserMessage(msg as Record<string, unknown>);
        break;

      case "stream_event":
        this.setProcessing();
        this.handlePartialMessage(msg as SDKPartialAssistantMessage);
        break;

      case "result":
        this.handleResult(msg as SDKResultMessage);
        break;

      // Subscription rate-limit info (claude.ai plans). The CLI emits these
      // routinely with status "allowed"; a "rejected" means the turn is dead
      // — without surfacing it the user just sees an empty reply.
      case "rate_limit_event": {
        const info = (msg as unknown as Record<string, unknown>).rate_limit_info as
          Record<string, unknown> | undefined;
        if (info) this.handleRateLimitInfo(info);
        break;
      }

      case "tool_progress": {
        const tp = msg as unknown as Record<string, unknown>;
        // Subagent tool progress is covered by task_progress.
        if (tp.parent_tool_use_id || tp.task_id) break;
        const secs = Math.round((tp.elapsed_time_seconds as number) ?? 0);
        this.setActivity(`${tp.tool_name as string} · ${secs}s`);
        break;
      }

      case "auth_status": {
        const a = msg as unknown as Record<string, unknown>;
        if (a.error) {
          this.emit("event", {
            kind: "error",
            content: `Authentication failed: ${a.error as string}`,
          } as StreamEvent);
        } else if (a.isAuthenticating) {
          this.emit("event", {
            kind: "notice",
            level: "warning",
            content: `Authenticating… ${((a.output as string[]) ?? []).join(" ")}`.trim(),
          } as StreamEvent);
        }
        break;
      }

      case "conversation_reset": {
        const r = msg as unknown as Record<string, unknown>;
        if (r.new_conversation_id) this.sessionId = r.new_conversation_id as string;
        this.emit("event", {
          kind: "notice",
          level: "notice",
          content: "Conversation reset — the next message starts a fresh context.",
        } as StreamEvent);
        break;
      }

      case "system": {
        const sys = msg as Record<string, unknown>;
        if (this.handleSystemBanner(sys)) break;
        if (sys.subtype === "commands_changed" && Array.isArray(sys.commands)) {
          const commands: CommandInfo[] = (sys.commands as Array<Record<string, unknown>>).map(
            (c) => ({
              name: c.name as string,
              description: c.description as string,
              argumentHint: c.argumentHint as string,
              aliases: c.aliases as string[] | undefined,
            }),
          );
          this.emit("commands", commands);
        } else if (sys.subtype === "task_started") {
          // task_started fires for every SDK task type: Task-tool subagents
          // (local_agent), background Bash commands (local_bash), workflow
          // runs (local_workflow)... Only real subagents get an agent bubble;
          // for the rest the originating tool_use is already shown. Untracked
          // task ids are dropped by the agentTaskIds guard below.
          const taskType = sys.task_type as string | undefined;
          const isAgentTask = taskType ? taskType === "local_agent" : sys.subagent_type != null;
          if (!isAgentTask || sys.skip_transcript) break;
          const taskId = sys.task_id as string;
          const toolUseId = sys.tool_use_id as string | undefined;
          const parentTaskId = toolUseId ? this.nestedToolUseToParent.get(toolUseId) : undefined;
          if (toolUseId) {
            this.subagentToolMap.set(toolUseId, taskId);
            this.taskToToolUse.set(taskId, toolUseId);
          }
          this.agentTaskIds.add(taskId);
          if (parentTaskId) this.nestedTaskToParent.set(taskId, parentTaskId);
          const parked = toolUseId ? this.pendingNested.get(toolUseId) : undefined;
          if (toolUseId) this.pendingNested.delete(toolUseId);
          const startEvent = {
            kind: "subagent_start",
            content: (sys.description as string) ?? "",
            toolUseId,
            subagent: {
              taskId,
              description: (sys.description as string) ?? "",
              prompt: sys.prompt as string | undefined,
              agentType: sys.subagent_type as string | undefined,
              status: "running",
              events: [],
            },
          } as StreamEvent;
          if (parentTaskId) {
            this.emitNestedEvent(parentTaskId, startEvent);
          } else {
            this.emit("event", startEvent);
          }
          for (const inner of parked ?? []) this.emitInner(toolUseId!, taskId, inner);
        } else if (sys.subtype === "task_progress") {
          const taskId = sys.task_id as string;
          if (!this.agentTaskIds.has(taskId)) break;
          const parentTaskId = this.nestedTaskToParent.get(taskId);
          const progressEvent = {
            kind: "subagent_progress",
            content: (sys.summary as string) ?? "",
            toolUseId: sys.tool_use_id as string | undefined,
            subagent: {
              taskId,
              description: (sys.description as string) ?? "",
              agentType: sys.subagent_type as string | undefined,
              status: "running",
              lastTool: sys.last_tool_name as string | undefined,
              usage: sys.usage
                ? {
                    totalTokens: (sys.usage as Record<string, number>).total_tokens ?? 0,
                    toolUses: (sys.usage as Record<string, number>).tool_uses ?? 0,
                    durationMs: (sys.usage as Record<string, number>).duration_ms ?? 0,
                  }
                : undefined,
              summary: sys.summary as string | undefined,
            },
          } as StreamEvent;
          if (parentTaskId) {
            this.emitNestedEvent(parentTaskId, progressEvent);
          } else {
            this.emit("event", progressEvent);
          }
        } else if (sys.subtype === "task_notification") {
          const taskId = sys.task_id as string;
          if (!this.agentTaskIds.has(taskId)) break;
          const parentTaskId = this.nestedTaskToParent.get(taskId);
          const doneEvent = {
            kind: "subagent_done",
            content: (sys.summary as string) ?? "",
            toolUseId: sys.tool_use_id as string | undefined,
            subagent: {
              taskId,
              description: "",
              status: sys.status as SubAgentInfo["status"],
              usage: sys.usage
                ? {
                    totalTokens: (sys.usage as Record<string, number>).total_tokens ?? 0,
                    toolUses: (sys.usage as Record<string, number>).tool_uses ?? 0,
                    durationMs: (sys.usage as Record<string, number>).duration_ms ?? 0,
                  }
                : undefined,
              summary: sys.summary as string | undefined,
            },
          } as StreamEvent;
          if (parentTaskId) {
            this.emitNestedEvent(parentTaskId, doneEvent);
          } else {
            this.emit("event", doneEvent);
          }
          this.cleanupTask(taskId);
        } else if (sys.subtype === "model_refusal_fallback") {
          const from = (sys.original_model as string) ?? "unknown";
          const to = (sys.fallback_model as string) ?? "unknown";
          this.emit("event", {
            kind: "error",
            content: `Model refused and fell back: ${from} → ${to}`,
          } as StreamEvent);
        } else if (sys.subtype === "model_refusal_no_fallback") {
          const category = (sys.category as string) ?? "";
          this.emit("event", {
            kind: "error",
            content: `Model refused${category ? ` (${category})` : ""} — no fallback configured`,
          } as StreamEvent);
        } else if (sys.subtype === "compact_boundary") {
          const meta = sys.compact_metadata as Record<string, unknown> | undefined;
          const pre = (meta?.pre_tokens as number) ?? 0;
          const post = (meta?.post_tokens as number) ?? 0;
          const dur = (meta?.duration_ms as number) ?? 0;
          const trigger = (meta?.trigger as string) ?? "auto";
          this.emit("event", {
            kind: "compact",
            content: `Context compacted (${trigger}): ${pre} → ${post} tokens, ${(dur / 1000).toFixed(1)}s`,
          } as StreamEvent);
        } else if (!ClaudeSession.SILENT_SYSTEM_SUBTYPES.has(sys.subtype as string)) {
          this.reportUnhandled(msg);
        }
        break;
      }

      default:
        if (!ClaudeSession.SILENT_TYPES.has((msg as { type: string }).type)) {
          this.reportUnhandled(msg);
        }
        break;
    }
  }

  // System messages that map to a banner/activity rather than to the task
  // machinery. Returns true when handled.
  private handleSystemBanner(sys: Record<string, unknown>): boolean {
    const notice = (content: string, level: NoticeLevel, extra: Partial<StreamEvent> = {}) =>
      this.emit("event", { kind: "notice", level, content, ...extra } as StreamEvent);

    switch (sys.subtype) {
      case "local_command_output": {
        // Output of a slash command run by the CLI (/compact, /cost...) —
        // shown as the reply text, exactly like the terminal does.
        const content = (sys.content as string) ?? "";
        if (content.trim()) this.emit("event", { kind: "text_delta", content } as StreamEvent);
        return true;
      }
      case "informational": {
        const content = (sys.content as string) ?? "";
        if (!content.trim()) return true;
        const level = sys.prevent_continuation
          ? "warning"
          : ((sys.level as NoticeLevel | undefined) ?? "notice");
        notice(content, level, { toolUseId: sys.tool_use_id as string | undefined });
        return true;
      }
      case "notification": {
        const text = (sys.text as string) ?? "";
        if (!text.trim()) return true;
        const priority = sys.priority as string;
        notice(text, priority === "high" || priority === "immediate" ? "warning" : "notice");
        return true;
      }
      case "api_retry": {
        const attempt = sys.attempt as number;
        const max = sys.max_retries as number;
        const delay = Math.round(((sys.retry_delay_ms as number) ?? 0) / 1000);
        const status = sys.error_status != null ? ` HTTP ${sys.error_status as number}` : "";
        const reason = sys.error ? ` (${String(sys.error).replace(/_/g, " ")})` : "";
        this.emit("event", {
          kind: "retry",
          level: "warning",
          content: `API retry ${attempt}/${max} in ${delay}s —${status}${reason}`,
        } as StreamEvent);
        this.setActivity(`retrying (${attempt}/${max})`);
        return true;
      }
      case "status": {
        const status = sys.status as string | null;
        if (sys.compact_result === "failed") {
          notice(
            `Context compaction failed: ${(sys.compact_error as string) ?? "unknown error"}`,
            "warning",
          );
        }
        if (status === "compacting") this.setActivity("compacting context");
        else if (this.activity === "compacting context") this.setActivity(null);
        return true;
      }
      case "permission_denied": {
        const reason = sys.decision_reason ? `: ${sys.decision_reason as string}` : "";
        const by = sys.decision_reason_type ? ` (${sys.decision_reason_type as string})` : "";
        notice(`Permission denied for ${sys.tool_name as string}${by}${reason}`, "warning", {
          toolUseId: sys.tool_use_id as string | undefined,
        });
        return true;
      }
      case "hook_started":
        this.setActivity(`hook: ${sys.hook_name as string}`);
        return true;
      case "hook_response": {
        if (this.activity?.startsWith("hook:")) this.setActivity(null);
        if (sys.outcome === "error") {
          const detail = ((sys.stderr as string) || (sys.output as string) || "").trim();
          notice(
            `Hook ${sys.hook_name as string} (${sys.hook_event as string}) failed${detail ? `: ${detail.slice(0, 400)}` : ""}`,
            "warning",
          );
        }
        return true;
      }
      case "session_state_changed": {
        const state = sys.state as string;
        if (state === "requires_action") this.setActivity("waiting for input");
        else if (state === "idle") this.setActivity(null);
        return true;
      }
      default:
        return false;
    }
  }

  private handleAssistantMessage(msg: SDKAssistantMessage): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) return;

    const parentToolUseId = msg.parent_tool_use_id ?? undefined;

    if (parentToolUseId) {
      const taskId = this.subagentToolMap.get(parentToolUseId);
      for (const block of content) {
        const b = block as unknown as Record<string, unknown>;
        const blockType = b.type as string;
        let ev: StreamEvent | null = null;
        if (blockType === "thinking") {
          const text = b.thinking as string;
          if (text) ev = { kind: "thinking", content: text } as StreamEvent;
        } else if (blockType === "text") {
          const text = (b.text as string)?.trim();
          if (text) ev = { kind: "text", content: text } as StreamEvent;
        } else if (blockType === "tool_use") {
          const innerToolId = b.id as string;
          // Mark this tool_use as belonging to a subagent so task_started
          // for it gets routed as a nested event, not a top-level subagent.
          if (taskId) this.nestedToolUseToParent.set(innerToolId, taskId);
          ev = {
            kind: "tool_use",
            content: formatToolUse(b),
            toolName: b.name as string,
            toolUseId: innerToolId,
            toolInput: extractToolInput(b),
          } as StreamEvent;
        } else if (blockType === "tool_result") {
          const rc = b.content as string;
          if (rc) ev = { kind: "tool_result", content: rc } as StreamEvent;
        }
        if (!ev) continue;
        if (taskId) this.emitInner(parentToolUseId, taskId, ev);
        else this.parkNested(parentToolUseId, ev);
      }
      return;
    }

    this.stepCounter++;
    const step = this.stepCounter;

    for (const block of content) {
      const b = block as unknown as Record<string, unknown>;
      const blockType = b.type as string;

      if (blockType === "thinking") {
        const text = b.thinking as string;
        if (text) {
          this.emit("event", { kind: "thinking", content: text, step } as StreamEvent);
        }
      } else if (blockType === "text") {
        const text = (b.text as string)?.trim();
        if (text) {
          this.emit("event", { kind: "text", content: text, step } as StreamEvent);
        }
      } else if (blockType === "tool_use") {
        const toolId = b.id as string;
        const toolInput = extractToolInput(b);
        this.emit("event", {
          kind: "tool_use",
          content: formatToolUse(b),
          toolName: b.name as string,
          toolInput,
          toolUseId: toolId,
          step,
        } as StreamEvent);
      } else if (blockType === "tool_result") {
        const resultContent = b.content as string;
        if (resultContent) {
          this.emit("event", {
            kind: "tool_result",
            content: resultContent,
            step,
          } as StreamEvent);
        }
      }
    }
  }

  private handleUserMessage(msg: Record<string, unknown>): void {
    const parentToolUseId = msg.parent_tool_use_id as string | undefined;
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const toolUseId = b.tool_use_id as string | undefined;
      let text = "";
      if (typeof b.content === "string") {
        text = b.content;
      } else if (Array.isArray(b.content)) {
        text = (b.content as Array<Record<string, unknown>>)
          .filter((c) => c.type === "text")
          .map((c) => c.text as string)
          .join("\n");
      }
      if (!text) continue;

      if (parentToolUseId) {
        const taskId = this.subagentToolMap.get(parentToolUseId);
        const inner = { kind: "tool_result", content: text, toolUseId } as StreamEvent;
        if (taskId) this.emitInner(parentToolUseId, taskId, inner);
        else this.parkNested(parentToolUseId, inner);
      } else {
        const isSubagentResult = toolUseId ? this.subagentToolMap.has(toolUseId) : false;
        this.emit("event", {
          kind: "tool_result",
          content: text,
          toolUseId,
          ...(isSubagentResult && { isMarkdown: true }),
        } as StreamEvent);
      }
    }
  }

  private handlePartialMessage(msg: SDKPartialAssistantMessage): void {
    const event = msg.event;
    if (!event) return;

    if (msg.parent_tool_use_id) return;

    const eventType = (event as unknown as Record<string, unknown>).type as string;

    if (eventType === "content_block_delta") {
      const delta = (event as unknown as Record<string, unknown>).delta as
        Record<string, unknown> | undefined;
      if (!delta) return;

      const deltaType = delta.type as string;
      if (deltaType === "thinking_delta") {
        const text = delta.thinking as string;
        if (text) {
          this.emit("event", { kind: "thinking_delta", content: text } as StreamEvent);
        }
      } else if (deltaType === "text_delta") {
        const text = delta.text as string;
        if (text) {
          this.emit("event", { kind: "text_delta", content: text } as StreamEvent);
        }
      }
    }
  }

  private handleResult(msg: SDKResultMessage): void {
    if (msg.subtype === "success") {
      const result = msg as Record<string, unknown>;
      const usage = result.usage as Record<string, number> | undefined;
      if (usage) {
        this.usage.input_tokens += usage.input_tokens ?? 0;
        this.usage.output_tokens += usage.output_tokens ?? 0;
        this.usage.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
        this.usage.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
      }

      const text = (result.result as string)?.trim() ?? "";
      this.emit("event", { kind: "result", content: text } as StreamEvent);
    } else {
      const errResult = msg as Record<string, unknown>;
      const errList = errResult.errors as string[] | undefined;
      const errMsg =
        (errList?.length ? errList.join("\n") : undefined) ??
        (errResult.error as string) ??
        `Turn failed (${(errResult.subtype as string) ?? "unknown error"})`;
      this.emit("event", { kind: "error", content: errMsg } as StreamEvent);
    }

    this.usage.turns++;
    if (this.turnStartTime) {
      this.usage.duration_ms += Date.now() - this.turnStartTime;
      this.turnStartTime = 0;
    }
    this.processing = false;
    this.pendingNested.clear();
    this.setActivity(null);
  }

  async getContextUsage(): Promise<Record<string, unknown> | null> {
    if (!this.queryInstance) return null;
    try {
      return (await this.queryInstance.getContextUsage()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getUsageInfo(): Promise<Record<string, unknown> | null> {
    if (!this.queryInstance) return null;
    try {
      const q = this.queryInstance as unknown as Record<string, unknown>;
      const fn = q["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"] as
        (() => Promise<unknown>) | undefined;
      if (!fn) return null;
      return (await fn.call(this.queryInstance)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  setEffort(level: string): void {
    this.config.effort = level;
    // Effort is passed as a CLI flag when the query starts, so close the
    // current query; the next send() restarts it with the new level and
    // resumes the conversation by session ID.
    if (this.queryInstance) {
      this.abort();
    }
  }

  abort(): void {
    this.intentionalAbort = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.queryInstance) {
      this.queryInstance.close();
      this.queryInstance = null;
    }
    if (this.inputController) {
      this.inputController.end();
      this.inputController = null;
    }
    this.iterating = false;
    this.processing = false;
    this.clearTrackingState();
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      config: { ...this.config },
      usage: { ...this.usage },
    };
  }

  static fromState(state: SessionState): ClaudeSession {
    const session = new ClaudeSession(state.config);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }

  private buildOptions(): Options {
    const opts: Options = {
      cwd: this.config.cwd,
      abortController: this.abortController ?? undefined,
      systemPrompt: this.config.systemPrompt
        ? {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: this.config.systemPrompt,
          }
        : { type: "preset" as const, preset: "claude_code" as const },
      skills: "all",
      includePartialMessages: true,
      forwardSubagentText: true,
      settingSources: ["user", "project", "local"],
      disallowedTools: DISALLOWED_TOOLS,
      // No fallbackModel: if the model is overloaded, fail rather than
      // silently downgrading.
    };

    if (this.sessionId) {
      opts.resume = this.sessionId;
    }
    if (this.config.model) {
      opts.model = this.config.model;
      // Fable 5 / Opus 4.7+ omit thinking text by default, so a long think
      // (minutes at high effort) looks like a hang. Request summarized
      // thinking so the UI can stream reasoning progress.
      if (supportsAdaptiveThinking(this.config.model)) {
        opts.thinking = { type: "adaptive", display: "summarized" };
      }
    }
    if (this.config.effort) {
      opts.effort = this.config.effort as EffortLevel;
    }
    if (this.config.permissionMode) {
      opts.permissionMode = this.config.permissionMode as PermissionMode;
      if (this.config.permissionMode === "bypassPermissions") {
        opts.allowDangerouslySkipPermissions = true;
      }
    }
    if (this.config.providerEnv) {
      opts.env = { ...process.env, ...this.config.providerEnv };
    }

    return opts;
  }
}

function extractToolInput(block: Record<string, unknown>): ToolInput | undefined {
  const name = block.name as string;
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return undefined;

  if (name === "Edit" || name === "Write") {
    return {
      tool: name,
      file_path: input.file_path as string | undefined,
      old_string: input.old_string as string | undefined,
      new_string: input.new_string as string | undefined,
    };
  }
  return undefined;
}

function formatToolUse(block: Record<string, unknown>): string {
  const name = block.name as string;
  const input = block.input as Record<string, unknown> | undefined;

  if (!input) return `**${name}**`;

  switch (name) {
    case "Bash":
      return `**Bash**\n\`\`\`bash\n${input.command}\n\`\`\``;

    case "Read":
      return `**Read** \`${input.file_path}\``;

    case "Write":
      return `**Write** \`${input.file_path}\`\n\`\`\`\n${input.content}\n\`\`\``;

    case "Edit": {
      const old_str = String(input.old_string ?? "");
      const new_str = String(input.new_string ?? "");
      return `**Edit** \`${input.file_path}\`\n\`\`\`diff\n${old_str
        .split("\n")
        .map((l) => "- " + l)
        .join("\n")}\n${new_str
        .split("\n")
        .map((l) => "+ " + l)
        .join("\n")}\n\`\`\``;
    }

    case "Grep":
      return `**Grep** \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ""}`;

    case "Glob":
      return `**Glob** \`${input.pattern}\``;

    case "Agent":
      return `**Agent** ${input.prompt ?? ""}`;

    default:
      return `**${name}**\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  }
}
