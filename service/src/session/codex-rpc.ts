import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// `codex app-server`: JSON-RPC 2.0 without the "jsonrpc" field, one message
// per line over stdio. The protocol is experimental and moves with the
// binary, so the binary is the pinned @openai/codex package's own, never
// a codex on PATH. Types below are the fields the session reads, checked
// against `codex app-server generate-ts --experimental` and the recordings
// in tests/snap/codex.

export interface RpcError {
  code?: number;
  message: string;
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

export class RpcRequestError extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcError,
  ) {
    super(error.message);
  }
}

// The two ends of a connection: what the session writes and what it reads.
// The real one is the child process; the snap tests play a recording.
export interface Transport {
  write(msg: RpcMessage): void;
  onMessage(cb: (msg: RpcMessage) => void): void;
  // The server is gone (exit code or signal, or why it never started).
  onClose(cb: (reason: string) => void): void;
  close(): void;
  // The process, where it is one (agy runs each command as a child of it).
  readonly pid?: number;
}

const PLATFORM_PACKAGES: Record<string, [string, string]> = {
  "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
};

// The native binary the @openai/codex package ships for this platform, run
// directly: its bin/codex.js only re-spawns it, at 50 MB of node a process.
export function codexBinary(): string {
  const target = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Codex has no binary for ${process.platform}-${process.arch}`);
  const [pkg, triple] = target;
  const root = path.dirname(require.resolve(`${pkg}/package.json`));
  const bin = path.join(
    root,
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!fs.existsSync(bin)) throw new Error(`Codex binary missing: ${bin} (npm install)`);
  return bin;
}

export function spawnAppServer(opts: {
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}): Transport {
  // A test that forgot its stand-in would start a session on the user's
  // account.
  if (process.env.VITEST) throw new Error("a test reached the real codex app-server");
  const child = spawn(codexBinary(), ["app-server", ...(opts.args ?? [])], {
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
  // "close", not "exit": the lines still in the pipe (a turn/completed
  // written just before a crash) come first.
  child.on("close", (code, signal) => {
    const tail = stderr.trim().split("\n").at(-1);
    close(`codex app-server exited (${code ?? signal})${tail ? `: ${tail}` : ""}`);
  });
  child.stdin.on("error", () => {});
  return {
    write: (msg) => {
      if (!closed) child.stdin.write(JSON.stringify(msg) + "\n");
    },
    onMessage: (cb) => listeners.push(cb),
    onClose: (cb) => closers.push(cb),
    close: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

// Requests by id over a transport; notifications and the server's own
// requests go to the handlers. A request still open when the server goes
// away fails with the reason.
export class AppServerClient {
  private nextId = 0;
  private pending = new Map<
    number,
    { method: string; resolve(v: unknown): void; reject(e: Error): void }
  >();
  closed: string | null = null;

  constructor(
    private transport: Transport,
    handlers: {
      notification(method: string, params: Record<string, unknown>): void;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
      close(reason: string): void;
    },
  ) {
    transport.onMessage((msg) => {
      if (msg.method && msg.id != null) {
        const id = msg.id;
        handlers.request(msg.method, (msg.params ?? {}) as Record<string, unknown>).then(
          (result) => transport.write({ id, result }),
          (e: unknown) =>
            transport.write({
              id,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
            }),
        );
      } else if (msg.method) {
        handlers.notification(msg.method, (msg.params ?? {}) as Record<string, unknown>);
      } else if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcRequestError(p.method, msg.error));
        else p.resolve(msg.result);
      }
    });
    transport.onClose((reason) => {
      this.closed = reason;
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
      handlers.close(reason);
    });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve, reject });
      this.transport.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.write({ method, ...(params !== undefined && { params }) });
  }

  // Connect: the handshake every connection starts with.
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "agent-team", version: "0" },
      // Client-defined tools (thread/start dynamicTools) are experimental.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  close(): void {
    this.transport.close();
  }
}

// --- protocol (the subset we read) ------------------------------------------

export interface UserInput {
  type: "text";
  text: string;
  text_elements: never[];
}

export interface CodexThread {
  id: string;
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: TurnError | null;
}

export type CodexErrorInfo = string | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResponse {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; clientId: string | null; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      commandActions: Array<{ type: string; command: string }>;
      status: "inProgress" | "completed" | "failed" | "declined";
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{ path: string; kind: { type: "add" | "delete" | "update" }; diff: string }>;
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result: { content: unknown[]; structuredContent: unknown } | null;
      error: { message: string } | null;
      durationMs: number | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: "inProgress" | "completed" | "failed";
      contentItems: Array<{ type: string; text?: string }> | null;
      success: boolean | null;
      durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: string;
      receiverThreadIds: string[];
      prompt: string | null;
    }
  | {
      type: "subAgentActivity";
      id: string;
      kind: "started" | "interacted" | "interrupted" | "completed";
      agentThreadId: string;
      agentPath: string;
    }
  | { type: "webSearch"; id: string; query: string }
  | { type: "imageView"; id: string; path: string }
  | { type: "plan"; id: string; text: string }
  | { type: "contextCompaction"; id: string };
