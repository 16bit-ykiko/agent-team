import { execSync } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import { StreamEvent, UsageStats, SessionConfig, SessionState } from "./session";
import type { Codex, ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk";

// The SDK ships a vendored binary per platform, but we may run against a
// system-installed codex — resolve it ourselves and pass codexPathOverride.
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
    codexBin = candidates.find((c) => c && fs.existsSync(c)) ?? "codex";
  }
  return codexBin;
}

// Codex sessions run through the official @openai/codex-sdk (a typed wrapper
// over `codex exec --json`; threads persist in ~/.codex/sessions and are
// resumed by id). Event mapping notes:
//  - agent_message → text_delta (task.ts builds content from deltas and
//    ignores plain "text" events)
//  - turn.completed → usage + a "result" event, which is what finalizes the
//    message; the old implementation never sent one, so codex replies stayed
//    "streaming" forever and the working state never cleared
//  - turn.failed / stream errors → "error" events (previously swallowed)
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

  private codex: Codex | null = null;
  private busy = false;
  private abortController: AbortController | null = null;
  private turnFinalized = false;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get isRunning(): boolean {
    return this.busy;
  }

  setEffort(level: string): void {
    // Thread options are per-turn (each run resumes by id), so the new level
    // applies from the next message.
    this.config.effort = level;
  }

  abort(): void {
    this.abortController?.abort();
  }

  setProviderEnv(env: Record<string, string> | undefined): void {
    this.config.providerEnv = env;
    // The Codex client caches apiKey/baseUrl; rebuild it on next turn.
    this.codex = null;
  }

  private async getCodex(): Promise<Codex> {
    if (this.codex) return this.codex;
    const { Codex } = await import("@openai/codex-sdk");
    const providerEnv = this.config.providerEnv ?? {};
    this.codex = new Codex({
      codexPathOverride: getCodexBin(),
      ...(providerEnv["OPENAI_API_KEY"] && { apiKey: providerEnv["OPENAI_API_KEY"] }),
      ...(providerEnv["OPENAI_BASE_URL"] && { baseUrl: providerEnv["OPENAI_BASE_URL"] }),
    });
    return this.codex;
  }

  private threadOptions(): ThreadOptions {
    return {
      workingDirectory: this.config.cwd,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      ...(this.config.model && { model: this.config.model }),
      ...(this.config.effort && {
        modelReasoningEffort: this.config.effort as ThreadOptions["modelReasoningEffort"],
      }),
    };
  }

  async send(message: string): Promise<void> {
    if (this.busy) throw new Error("Session is busy");
    this.busy = true;
    this.turnFinalized = false;
    const startTime = Date.now();
    this.abortController = new AbortController();

    try {
      const codex = await this.getCodex();
      const thread = this.sessionId
        ? codex.resumeThread(this.sessionId, this.threadOptions())
        : codex.startThread(this.threadOptions());

      const { events } = await thread.runStreamed(message, {
        signal: this.abortController.signal,
      });
      for await (const ev of events) {
        this.handleThreadEvent(ev);
      }

      // Stream ended without turn.completed/turn.failed (e.g. process died):
      // still close the message so the UI doesn't stay "working" forever.
      if (!this.turnFinalized && !this.abortController.signal.aborted) {
        this.emit("event", { kind: "result", content: "" } as StreamEvent);
      }
    } catch (err) {
      if (!this.abortController.signal.aborted && !this.turnFinalized) {
        const msg = err instanceof Error ? err.message : String(err);
        // A failed resume usually means the thread is gone from
        // ~/.codex/sessions — reset so the next message starts fresh.
        if (this.sessionId && /resume|session|thread|not found|No such/i.test(msg)) {
          this.sessionId = null;
          this.emit("event", {
            kind: "error",
            content: `[Codex error] ${msg}\n\nThe stored Codex session could not be resumed; the next message will start a fresh session.`,
          } as StreamEvent);
        } else {
          this.emit("event", { kind: "error", content: `[Codex error] ${msg}` } as StreamEvent);
        }
      }
    } finally {
      this.usage.turns++;
      this.usage.duration_ms += Date.now() - startTime;
      this.busy = false;
      this.abortController = null;
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

  private handleThreadEvent(ev: ThreadEvent): void {
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) this.sessionId = ev.thread_id;
        break;

      case "turn.completed":
        if (ev.usage) {
          this.usage.input_tokens += ev.usage.input_tokens ?? 0;
          this.usage.output_tokens += ev.usage.output_tokens ?? 0;
          this.usage.cache_read_tokens += ev.usage.cached_input_tokens ?? 0;
          this.usage.cache_creation_tokens += ev.usage.cache_write_input_tokens ?? 0;
        }
        this.turnFinalized = true;
        this.emit("event", { kind: "result", content: "" } as StreamEvent);
        break;

      // Real failure streams carry BOTH a stream-level "error" and a
      // "turn.failed" for the same fault (observed live: thread.started →
      // turn.started → error → turn.failed → generator throw). Emit only the
      // first; a second error event would open a fresh error bubble after the
      // message was already finalized.
      case "turn.failed":
        if (this.turnFinalized) break;
        this.turnFinalized = true;
        this.emit("event", {
          kind: "error",
          content: `[Codex error] ${ev.error?.message ?? "Turn failed"}`,
        } as StreamEvent);
        break;

      case "error":
        if (this.turnFinalized) break;
        this.turnFinalized = true;
        this.emit("event", {
          kind: "error",
          content: `[Codex error] ${ev.message ?? "Unknown stream error"}`,
        } as StreamEvent);
        break;

      case "item.started": {
        const event = parseStartedItem(ev.item);
        if (event) this.emit("event", event);
        break;
      }

      case "item.completed": {
        const event = parseCompletedItem(ev.item);
        if (event) this.emit("event", event);
        break;
      }

      default:
        break;
    }
  }
}

function parseStartedItem(item: ThreadItem): StreamEvent | null {
  switch (item.type) {
    case "command_execution":
      return {
        kind: "tool_use",
        toolName: "Bash",
        content: `**Bash**\n\`\`\`bash\n${item.command}\n\`\`\``,
        toolUseId: item.id,
      };
    case "mcp_tool_call":
      return {
        kind: "tool_use",
        toolName: "MCP",
        content: `**MCP** \`${item.server}.${item.tool}\``,
        toolUseId: item.id,
      };
    case "web_search":
      return {
        kind: "tool_use",
        toolName: "WebSearch",
        content: `**WebSearch** ${item.query}`,
        toolUseId: item.id,
      };
    default:
      return null;
  }
}

function parseCompletedItem(item: ThreadItem): StreamEvent | null {
  switch (item.type) {
    case "agent_message": {
      const text = item.text?.trim();
      // Deltas are what task.ts accumulates into the message content.
      return text ? { kind: "text_delta", content: text } : null;
    }

    case "reasoning": {
      const text = item.text?.trim();
      return text ? { kind: "thinking", content: text } : null;
    }

    case "command_execution": {
      const status =
        item.exit_code === 0 || item.exit_code == null ? "" : ` (exit code ${item.exit_code})`;
      const output = item.aggregated_output ?? "";
      if (!output && !status) return null;
      return { kind: "tool_result", content: `${output}${status}`, toolUseId: item.id };
    }

    case "mcp_tool_call": {
      const body = item.error
        ? `Error: ${item.error.message}`
        : JSON.stringify(item.result?.structured_content ?? item.result?.content ?? "done");
      return { kind: "tool_result", content: body, toolUseId: item.id };
    }

    case "file_change": {
      const changes = item.changes
        .map((c) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"} ${c.path}`)
        .join("\n");
      const status = item.status === "failed" ? " (failed)" : "";
      return {
        kind: "tool_use",
        toolName: "Edit",
        content: `**Edit**${status}\n\`\`\`\n${changes}\n\`\`\``,
        toolUseId: item.id,
      };
    }

    case "web_search":
      // Started with the query; completion carries no result payload, but
      // closing the pair keeps the UI from showing it as still running.
      return { kind: "tool_result", content: "done", toolUseId: item.id };

    case "todo_list": {
      const lines = item.items.map((t) => `- [${t.completed ? "x" : " "}] ${t.text}`);
      return lines.length
        ? { kind: "notice", level: "info", content: `**Plan**\n${lines.join("\n")}` }
        : null;
    }

    case "error":
      // Non-fatal item-level error: surface it without finalizing the turn.
      return { kind: "notice", level: "warning", content: `Codex: ${item.message}` };

    default:
      return null;
  }
}
