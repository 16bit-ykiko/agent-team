import { EventEmitter } from "events";
import { execSync } from "child_process";
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

export interface StreamEvent {
  kind:
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
    | "compact";
  content: string;
  raw?: unknown;
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
  distro?: string;
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
  private subagentToolMap = new Map<string, string>();
  private toolNameMap = new Map<string, string>();
  private agentTaskIds = new Set<string>();

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.processing;
  }

  async send(message: string): Promise<void> {
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

    this.queryInstance!.supportedCommands().then((cmds) => {
      const commands: CommandInfo[] = cmds.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        aliases: c.aliases,
      }));
      this.emit("commands", commands);
    }).catch(() => {});
  }

  private pushMessage(message: string): void {
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
        const errMsg = err instanceof Error ? err.message : String(err);
        this.emit("event", { kind: "error", content: `[Claude error] ${errMsg}` } as StreamEvent);
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

      case "system": {
        const sys = msg as Record<string, unknown>;
        if (sys.subtype === "commands_changed" && Array.isArray(sys.commands)) {
          const commands: CommandInfo[] = (sys.commands as Array<Record<string, unknown>>).map((c) => ({
            name: c.name as string,
            description: c.description as string,
            argumentHint: c.argumentHint as string,
            aliases: c.aliases as string[] | undefined,
          }));
          this.emit("commands", commands);
        } else if (sys.subtype === "task_started") {
          const taskId = sys.task_id as string;
          const toolUseId = sys.tool_use_id as string | undefined;
          if (toolUseId) {
            const toolName = this.toolNameMap.get(toolUseId);
            if (toolName && toolName !== "Agent") break;
            this.subagentToolMap.set(toolUseId, taskId);
          }
          this.agentTaskIds.add(taskId);
          this.emit("event", {
            kind: "subagent_start",
            content: (sys.description as string) ?? "",
            raw: msg,
            toolUseId,
            subagent: {
              taskId,
              description: (sys.description as string) ?? "",
              prompt: sys.prompt as string | undefined,
              agentType: sys.subagent_type as string | undefined,
              status: "running",
              events: [],
            },
          } as StreamEvent);
        } else if (sys.subtype === "task_progress") {
          if (!this.agentTaskIds.has(sys.task_id as string)) break;
          this.emit("event", {
            kind: "subagent_progress",
            content: (sys.summary as string) ?? "",
            raw: msg,
            toolUseId: sys.tool_use_id as string | undefined,
            subagent: {
              taskId: sys.task_id as string,
              description: (sys.description as string) ?? "",
              agentType: sys.subagent_type as string | undefined,
              status: "running",
              lastTool: sys.last_tool_name as string | undefined,
              usage: sys.usage ? {
                totalTokens: (sys.usage as Record<string, number>).total_tokens ?? 0,
                toolUses: (sys.usage as Record<string, number>).tool_uses ?? 0,
                durationMs: (sys.usage as Record<string, number>).duration_ms ?? 0,
              } : undefined,
              summary: sys.summary as string | undefined,
            },
          } as StreamEvent);
        } else if (sys.subtype === "task_notification") {
          if (!this.agentTaskIds.has(sys.task_id as string)) break;
          this.emit("event", {
            kind: "subagent_done",
            content: (sys.summary as string) ?? "",
            raw: msg,
            toolUseId: sys.tool_use_id as string | undefined,
            subagent: {
              taskId: sys.task_id as string,
              description: "",
              status: sys.status as SubAgentInfo["status"],
              usage: sys.usage ? {
                totalTokens: (sys.usage as Record<string, number>).total_tokens ?? 0,
                toolUses: (sys.usage as Record<string, number>).tool_uses ?? 0,
                durationMs: (sys.usage as Record<string, number>).duration_ms ?? 0,
              } : undefined,
              summary: sys.summary as string | undefined,
            },
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
        }
        break;
      }

      default:
        break;
    }
  }

  private handleAssistantMessage(msg: SDKAssistantMessage): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) return;

    const parentToolUseId = msg.parent_tool_use_id ?? undefined;

    if (parentToolUseId) {
      const taskId = this.subagentToolMap.get(parentToolUseId);
      if (!taskId) return;
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
          ev = { kind: "tool_use", content: formatToolUse(b), toolUseId: b.id as string, toolInput: extractToolInput(b) } as StreamEvent;
        } else if (blockType === "tool_result") {
          const rc = b.content as string;
          if (rc) ev = { kind: "tool_result", content: rc } as StreamEvent;
        }
        if (ev) {
          this.emit("event", {
            kind: "subagent_progress",
            content: "",
            toolUseId: parentToolUseId,
            subagent: { taskId, description: "", _innerEvent: ev },
          } as StreamEvent);
        }
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
          this.emit("event", { kind: "thinking", content: text, raw: msg, step } as StreamEvent);
        }
      } else if (blockType === "text") {
        const text = (b.text as string)?.trim();
        if (text) {
          this.emit("event", { kind: "text", content: text, raw: msg, step } as StreamEvent);
        }
      } else if (blockType === "tool_use") {
        const toolId = b.id as string;
        const toolName = b.name as string;
        if (toolId && toolName) this.toolNameMap.set(toolId, toolName);
        const toolInput = extractToolInput(b);
        this.emit("event", {
          kind: "tool_use",
          content: formatToolUse(b),
          raw: msg,
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
            raw: msg,
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
        if (taskId) {
          this.emit("event", {
            kind: "subagent_progress",
            content: "",
            toolUseId: parentToolUseId,
            subagent: { taskId, description: "", _innerEvent: { kind: "tool_result", content: text, toolUseId } as StreamEvent },
          } as StreamEvent);
        }
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
        | Record<string, unknown>
        | undefined;
      if (!delta) return;

      const deltaType = delta.type as string;
      if (deltaType === "thinking_delta") {
        const text = delta.thinking as string;
        if (text) {
          this.emit("event", { kind: "thinking_delta", content: text, raw: msg } as StreamEvent);
        }
      } else if (deltaType === "text_delta") {
        const text = delta.text as string;
        if (text) {
          this.emit("event", { kind: "text_delta", content: text, raw: msg } as StreamEvent);
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
      this.emit("event", { kind: "result", content: text, raw: msg } as StreamEvent);
    } else {
      const errResult = msg as Record<string, unknown>;
      const errMsg = (errResult.error as string) ?? "Unknown error";
      this.emit("event", { kind: "error", content: errMsg, raw: msg } as StreamEvent);
    }

    this.usage.turns++;
    if (this.turnStartTime) {
      this.usage.duration_ms += Date.now() - this.turnStartTime;
      this.turnStartTime = 0;
    }
    this.processing = false;
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
        | (() => Promise<unknown>)
        | undefined;
      if (!fn) return null;
      return (await fn.call(this.queryInstance)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  abort(): void {
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
    };

    if (this.sessionId) {
      opts.resume = this.sessionId;
    }
    if (this.config.model) {
      opts.model = this.config.model;
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

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

let wslBin: string | null = null;
export function getWslBin(): string {
  if (wslBin) return wslBin;
  try {
    wslBin = execSync("which wsl.exe", { encoding: "utf-8" }).trim();
  } catch {
    const candidates = ["/mnt/c/Windows/System32/wsl.exe", "/mnt/c/WINDOWS/system32/wsl.exe"];
    wslBin =
      candidates.find((c) => {
        try {
          return require("fs").existsSync(c);
        } catch {
          return false;
        }
      }) ?? "wsl.exe";
  }
  return wslBin;
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
