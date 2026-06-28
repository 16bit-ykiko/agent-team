import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { StreamEvent, UsageStats, SessionConfig, SessionState, shellQuote, DISTRO_PATH_PREFIX, getWslBin } from "./session";

let codexBin: string | null = null;
function getCodexBin(): string {
  if (codexBin) return codexBin;
  try {
    codexBin = execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    const candidates = [
      process.env.CODEX_BIN,
      `${process.env.HOME}/.pixi/envs/nodejs/bin/codex`,
      `${process.env.HOME}/.local/bin/codex`,
      "/usr/local/bin/codex",
    ];
    codexBin = candidates.find((c) => c && require("fs").existsSync(c)) ?? "codex";
  }
  return codexBin;
}

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

  static fromState(state: SessionState): CodexSession {
    const session = new CodexSession(state.config);
    session.sessionId = state.sessionId;
    session.usage = { ...state.usage };
    return session;
  }

  private buildArgs(): string[] {
    if (this.sessionId) {
      const args = [
        "exec", "resume", this.sessionId,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
      if (this.config.model) args.push("-m", this.config.model);
      if (this.config.effort) args.push("-c", `effort=${this.config.effort}`);
      args.push("-");
      return args;
    }

    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color", "never",
    ];
    if (this.config.model) args.push("-m", this.config.model);
    if (this.config.effort) args.push("-c", `effort=${this.config.effort}`);
    args.push("-");
    return args;
  }

  private run(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs();

      const extraEnv: Record<string, string> = {};
      if (this.config.providerEnv) {
        const apiKey = this.config.providerEnv["OPENAI_API_KEY"];
        if (apiKey) extraEnv["OPENAI_API_KEY"] = apiKey;
        const baseUrl = this.config.providerEnv["OPENAI_BASE_URL"];
        if (baseUrl) extraEnv["OPENAI_BASE_URL"] = baseUrl;
      }

      if (this.config.distro) {
        const escaped = args.map(shellQuote).join(" ");
        const envExports = Object.entries(extraEnv)
          .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
          .join(" && ");
        const prefix = envExports ? `${envExports} && ` : "";
        const cmd = `${prefix}cd ${shellQuote(this.config.cwd)} && codex ${escaped}`;
        this.proc = spawn(getWslBin(), ["-d", this.config.distro, "--", "bash", "-ic", cmd], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        this.proc = spawn(getCodexBin(), args, {
          cwd: this.config.cwd,
          env: {
            ...process.env,
            ...extraEnv,
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
          this.handleNotification(data);
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
          const msg = stderr.trim() || `Codex exited with code ${code}`;
          this.emit("event", {
            kind: "error",
            content: `[Codex error] ${msg}`,
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
          content: `[Codex error] ${err.message}`,
        } as StreamEvent);
        reject(err);
      });
    });
  }

  private handleNotification(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;
    const type = obj.type as string | undefined;
    if (!type) return;

    if (type === "thread.started") {
      const threadId = obj.thread_id as string;
      if (threadId) this.sessionId = threadId;
      return;
    }

    if (type === "turn.completed") {
      const usage = obj.usage as Record<string, number> | undefined;
      if (usage) {
        this.usage.input_tokens += usage.input_tokens ?? 0;
        this.usage.output_tokens += usage.output_tokens ?? 0;
        this.usage.cache_read_tokens += usage.cached_input_tokens ?? 0;
      }
      return;
    }

    if (type === "item.started") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item) {
        const event = parseStartedItem(item);
        if (event) this.emit("event", event);
      }
      return;
    }

    if (type === "item.completed") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item) {
        const event = parseCompletedItem(item);
        if (event) this.emit("event", event);
      }
      return;
    }
  }
}

function parseStartedItem(item: Record<string, unknown>): StreamEvent | null {
  const type = item.type as string;

  if (type === "command_execution") {
    const command = item.command as string;
    if (command) {
      return {
        kind: "tool_use",
        content: `**Bash**\n\`\`\`bash\n${command}\n\`\`\``,
      };
    }
  }

  return null;
}

function parseCompletedItem(item: Record<string, unknown>): StreamEvent | null {
  const type = item.type as string;

  if (type === "agent_message") {
    const text = (item.text as string)?.trim();
    if (text) {
      return { kind: "text", content: text, raw: item };
    }
  }

  if (type === "command_execution") {
    const exitCode = item.exit_code as number | undefined;
    const output = item.aggregated_output as string;
    if (output) {
      const status = exitCode === 0 ? "" : ` (exit code ${exitCode})`;
      return { kind: "tool_result", content: `${output}${status}` };
    }
  }

  if (type === "file_change") {
    const filePath = item.file_path as string;
    const patch = item.patch as string;
    if (filePath && patch) {
      return {
        kind: "tool_use",
        content: `**Edit** \`${filePath}\`\n\`\`\`diff\n${patch}\n\`\`\``,
        toolInput: { tool: "Edit", file_path: filePath },
      };
    }
  }

  return null;
}
