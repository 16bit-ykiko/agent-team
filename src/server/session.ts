import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";

export interface StreamEvent {
  kind:
    | "thinking"
    | "text"
    | "tool_use"
    | "tool_result"
    | "result"
    | "error";
  content: string;
  raw?: unknown;
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
  model?: string;
  effort?: string;
  permissionMode?: string;
  systemPrompt?: string;
}

export interface SessionState {
  sessionId: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  systemPrompt?: string;
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

const TIMEOUT_MS = 600_000;

export class ClaudeSession extends EventEmitter {
  sessionId: string | null = null;
  usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
  };

  private config: SessionConfig;
  private proc: ChildProcess | null = null;
  private busy = false;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.busy;
  }

  async send(message: string): Promise<void> {
    if (this.busy) {
      throw new Error("Session is busy");
    }
    this.busy = true;
    const startTime = Date.now();

    try {
      await this.run(message);
    } finally {
      this.usage.turns++;
      this.usage.duration_ms += Date.now() - startTime;
      this.busy = false;
    }
  }

  abort(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          this.proc.kill("SIGKILL");
        }
      }, 3000);
    }
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      cwd: this.config.cwd,
      model: this.config.model,
      effort: this.config.effort,
      permissionMode: this.config.permissionMode,
      systemPrompt: this.config.systemPrompt,
      usage: { ...this.usage },
    };
  }

  static fromState(state: SessionState): ClaudeSession {
    const session = new ClaudeSession({
      cwd: state.cwd,
      model: state.model,
      effort: state.effort,
      permissionMode: state.permissionMode,
      systemPrompt: state.systemPrompt,
    });
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }

  private buildArgs(message: string): string[] {
    const args = ["-p", message, "--output-format", "stream-json", "--verbose"];

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    if (this.config.effort) {
      args.push("--effort", this.config.effort);
    }
    if (this.config.permissionMode) {
      args.push("--permission-mode", this.config.permissionMode);
    }
    if (this.config.systemPrompt) {
      args.push("--append-system-prompt", this.config.systemPrompt);
    }

    args.push("--disallowed-tools", DISALLOWED_TOOLS.join(","));

    return args;
  }

  private run(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);

      this.proc = spawn("claude", args, {
        cwd: this.config.cwd,
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.emit("event", {
            kind: "error",
            content: "[Timeout] Session exceeded time limit",
          } as StreamEvent);
          this.abort();
          reject(new Error("Session timeout"));
        }
      }, TIMEOUT_MS);

      const rl = readline.createInterface({ input: this.proc.stdout! });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const data = JSON.parse(line);
          this.handleStreamData(data);
        } catch {
          // ignore malformed lines
        }
      });

      this.proc.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      this.proc.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        if (code !== 0 && code !== null) {
          const msg = stderr.trim() || `Process exited with code ${code}`;
          this.emit("event", {
            kind: "error",
            content: `[Claude error] ${msg}`,
          } as StreamEvent);
          reject(new Error(msg));
        } else {
          resolve();
        }
      });

      this.proc.on("error", (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.emit("event", {
          kind: "error",
          content: `[Claude error] ${err.message}`,
        } as StreamEvent);
        reject(err);
      });
    });
  }

  private handleStreamData(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;

    if (obj.session_id && typeof obj.session_id === "string") {
      this.sessionId = obj.session_id;
    }

    const event = parseStreamEvent(obj);
    if (event) {
      this.emit("event", event);
    }

    if (obj.type === "result") {
      this.updateUsage(obj);
    }
  }

  private updateUsage(result: Record<string, unknown>): void {
    const usage = result.usage as Record<string, number> | undefined;
    if (!usage) return;
    this.usage.input_tokens += usage.input_tokens ?? 0;
    this.usage.output_tokens += usage.output_tokens ?? 0;
    this.usage.cache_read_tokens += usage.cache_read_tokens ?? 0;
    this.usage.cache_creation_tokens += usage.cache_creation_tokens ?? 0;
  }
}

function parseStreamEvent(obj: Record<string, unknown>): StreamEvent | null {
  const type = obj.type as string | undefined;

  if (type === "assistant") {
    return parseAssistantEvent(obj);
  }

  if (type === "result") {
    const text = extractResultText(obj);
    if (text) {
      return { kind: "result", content: text, raw: obj };
    }
    return null;
  }

  if (type === "error" || type === "rate_limit_event") {
    const msg =
      (obj.error as Record<string, unknown>)?.message ??
      obj.message ??
      JSON.stringify(obj);
    return { kind: "error", content: String(msg), raw: obj };
  }

  return null;
}

function parseAssistantEvent(obj: Record<string, unknown>): StreamEvent | null {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (!content || !Array.isArray(content)) return null;

  for (const block of content) {
    const b = block as Record<string, unknown>;
    const blockType = b.type as string;

    if (blockType === "thinking") {
      const text = b.thinking as string;
      if (text) return { kind: "thinking", content: text, raw: obj };
    }

    if (blockType === "text") {
      const text = b.text as string;
      if (text) return { kind: "text", content: text, raw: obj };
    }

    if (blockType === "tool_use") {
      return {
        kind: "tool_use",
        content: formatToolUse(b),
        raw: obj,
      };
    }

    if (blockType === "tool_result") {
      const resultContent = b.content as string;
      if (resultContent) {
        return { kind: "tool_result", content: resultContent, raw: obj };
      }
    }
  }

  return null;
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
      return `**Write** \`${input.file_path}\`\n\`\`\`\n${truncate(String(input.content ?? ""), 500)}\n\`\`\``;

    case "Edit":
      return `**Edit** \`${input.file_path}\``;

    case "Grep":
      return `**Grep** \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ""}`;

    case "Glob":
      return `**Glob** \`${input.pattern}\``;

    case "Agent": {
      const prompt = truncate(String(input.prompt ?? ""), 200);
      return `**Agent** ${prompt}`;
    }

    default:
      return `**${name}**\n\`\`\`json\n${truncate(JSON.stringify(input, null, 2), 500)}\n\`\`\``;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function extractResultText(obj: Record<string, unknown>): string | null {
  const result = obj.result as string | undefined;
  if (result) return result;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}
