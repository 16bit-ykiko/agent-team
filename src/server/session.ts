import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";

let claudeBin: string | null = null;
function getClaudeBin(): string {
  if (claudeBin) return claudeBin;
  try {
    claudeBin = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    const candidates = [
      process.env.CLAUDE_BIN,
      `${process.env.HOME}/.pixi/envs/nodejs/bin/claude`,
      `${process.env.HOME}/.local/bin/claude`,
      "/usr/local/bin/claude",
    ];
    claudeBin = candidates.find((c) => c && require("fs").existsSync(c)) ?? "claude";
  }
  return claudeBin;
}

export interface ToolInput {
  tool: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export interface StreamEvent {
  kind: "thinking" | "text" | "tool_use" | "tool_result" | "result" | "error";
  content: string;
  raw?: unknown;
  toolInput?: ToolInput;
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

  private buildArgs(): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

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
      const args = this.buildArgs();

      const extraEnv = this.config.providerEnv ?? {};
      if (Object.keys(extraEnv).length > 0) {
        console.log(`[session] Using provider env: ${Object.keys(extraEnv).join(", ")}`);
      }

      if (this.config.distro) {
        const escaped = args.map(shellQuote).join(" ");
        const envExports = Object.entries({
          ...extraEnv,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "true",
        })
          .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
          .join(" && ");
        const cmd = `${envExports} && cd ${shellQuote(this.config.cwd)} && claude ${escaped}`;
        this.proc = spawn(getWslBin(), ["-d", this.config.distro, "--", "bash", "-ic", cmd], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        this.proc = spawn(getClaudeBin(), args, {
          cwd: this.config.cwd,
          env: {
            ...process.env,
            ...extraEnv,
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "true",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      }

      this.proc.stdin!.write(message);
      this.proc.stdin!.end();

      let stderr = "";
      let settled = false;

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

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const DISTRO_PATH_PREFIX =
  "$HOME/.pixi/envs/nodejs/bin:$HOME/.pixi/envs/default/bin:$HOME/.pixi/bin:$HOME/.local/bin:$HOME/.cargo/bin";

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

function parseStreamEvent(obj: Record<string, unknown>): StreamEvent | null {
  const type = obj.type as string | undefined;

  if (type === "assistant") {
    return parseAssistantEvent(obj);
  }

  if (type === "result") {
    const text = (obj.result as string)?.trim();
    if (text) return { kind: "text", content: text, raw: obj };
    return null;
  }

  if (type === "rate_limit_event") {
    return null;
  }

  if (type === "error") {
    const msg =
      (obj.error as Record<string, unknown>)?.message ?? obj.message ?? JSON.stringify(obj);
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
      const text = (b.text as string)?.trim();
      if (text) return { kind: "text", content: text, raw: obj };
    }

    if (blockType === "tool_use") {
      const toolInput = extractToolInput(b);
      return {
        kind: "tool_use",
        content: formatToolUse(b),
        raw: obj,
        toolInput,
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
