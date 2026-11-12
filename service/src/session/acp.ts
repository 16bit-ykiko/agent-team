import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import type { RpcMessage, Transport } from "./codex-rpc";

// `agy acp`: the Agent Client Protocol (v1: JSON-RPC 2.0, one message per
// line over stdio) of Google's Antigravity CLI. The binary is the user's own
// install, signed in to their Google account; the panel only spawns it and
// never touches its login. Types below are the fields the session reads,
// checked against the recordings in tests/snap/agy.

// On PATH, else where agy's installer puts it (a service's PATH often lacks
// ~/.local/bin).
export function agyBinary(): string {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), ".local", "bin"));
  for (const dir of dirs) {
    const bin = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy");
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      // not here
    }
  }
  throw new Error("agy (Antigravity CLI) not found on PATH or in ~/.local/bin");
}

export function spawnAgy(opts: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): Transport {
  // A test that forgot its stand-in would start a session on the user's
  // account.
  if (process.env.VITEST) throw new Error("a test reached the real agy");
  const child = spawn(agyBinary(), ["acp", ...opts.args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const listeners: Array<(m: RpcMessage) => void> = [];
  const closers: Array<(reason: string) => void> = [];
  let closed = false;
  let stderr = "";
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closers) cb(reason);
  };
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    for (const cb of listeners) cb(msg);
  });
  child.on("error", (e) => close(e.message));
  child.on("close", (code, signal) => {
    const tail = stderr.trim().split("\n").at(-1);
    close(`agy acp exited (${code ?? signal})${tail ? `: ${tail}` : ""}`);
  });
  child.stdin.on("error", () => {});
  return {
    write: (msg) => {
      if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    },
    onMessage: (cb) => listeners.push(cb),
    onClose: (cb) => closers.push(cb),
    // One that ignores SIGTERM is killed: a session left on a stopped
    // process waits for it to go.
    close: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    },
    pid: child.pid,
  };
}

// The process groups agy leads, oldest first: each command it runs is
// `bash -c <command>` (or what bash execed in its place), a child of agy
// leading a group of its own on a terminal (agy/background). The panel MCP
// bridge agy spawns is left out. Linux: read from /proc.
export function processGroups(agyPid: number): Array<{ pid: number; argv: string[] }> {
  const found: Array<{ pid: number; start: number; argv: string[] }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      // The fields after the command name, which may hold spaces itself:
      // state, ppid, pgrp, … starttime (the 22nd field).
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pid = Number(entry);
      if (Number(fields[1]) !== agyPid || Number(fields[2]) !== pid) continue;
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (argv.some((a) => a.includes("agent-team-mcp-"))) continue;
      found.push({ pid, start: Number(fields[19]), argv });
    } catch {
      // gone meanwhile
    }
  }
  return found
    .sort((a, b) => a.start - b.start || a.pid - b.pid)
    .map(({ pid, argv }) => ({ pid, argv }));
}

// --- protocol (the subset we read) ------------------------------------------

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface ToolCallContent {
  type: string;
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: Array<{ path: string; line?: number }>;
  // agy's own: its tool's name and arguments.
  name?: string;
  args?: Record<string, unknown>;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & ToolCall)
  | {
      sessionUpdate: "plan";
      entries: Array<{ content: string; status: string; priority?: string }>;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: Array<{ name: string; description?: string; input?: { hint?: string } }>;
    }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "usage_update"; used?: number; size?: number };

export interface ConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string }>;
}

export interface PromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface PromptResponse {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  usage?: PromptUsage;
}

export interface SessionResponse {
  sessionId?: string;
  configOptions?: ConfigOption[];
}
