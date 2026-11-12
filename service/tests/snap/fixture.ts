// The fixture script: what a recorded interaction does and why it exists.
// No test or SDK dependencies, so scripts/capture-sdk.ts can load fixtures
// under plain node.
import type { Message } from "../../src/workspace/workspace";
import type { StreamEvent, UsageStats } from "../../src/session/claude";
import type { RpcMessage } from "../../src/session/codex-rpc";
import type { PanelToolset } from "../../src/project/tools";
import { z } from "zod";

export type Backend = "claude" | "codex" | "cursor" | "agy";

export type Step =
  // Codex: turn/start when no turn runs, turn/steer into the running one.
  // `requeued`: the panel sends it by itself (a steered message the stopped
  // turn never read, back from the queue); the replay only expects it.
  | { op: "send"; text: string; requeued?: true }
  // Recording pacing only: "result" = the turn's result frame arrived,
  // "idle" = result and no live background task, a number = milliseconds,
  // { frame } = a frame whose JSON contains the string arrived.
  | { op: "wait"; for: "result" | "idle" | number | { frame: string } }
  // End the backend process (a server restart); the next send resumes.
  | { op: "end" }
  // The user's Stop button mid-turn.
  | { op: "abort" }
  // Query.interrupt() / turn/interrupt: stop the running turn, keep the process.
  | { op: "interrupt" }
  // Query.stopTask() on the latest listed task matching `match`.
  | { op: "stopTask"; match: { type?: string; ambient?: boolean } }
  // Codex: thread/compact/start, the user's /compact.
  | { op: "compact" };

export interface Replay {
  messages: Message[];
  events: StreamEvent[];
  states: string[];
  // What the sessions reported as usage limits (the server's rateLimit).
  limits: { rateLimitType?: string; resetsAt?: number }[];
  // Every session handle the workspace created, in order (a restart adds one).
  sessions: {
    sessionId: string | null;
    usage: UsageStats;
    runState?: string;
    backgroundTaskList?: { id: string }[];
  }[];
  // Codex, agy: every message the sessions wrote to the backend process.
  sent: RpcMessage[];
  // Cursor: the SDK calls the sessions made, in order ("create", "resume
  // <id>", "send", "cancel"), and what each send passed.
  sdkCalls: string[];
  sends: Array<{ model?: unknown; local?: Record<string, unknown> }>;
}

// Codex: a tool the client defines (thread/start dynamicTools) and answers
// itself when the model calls it (item/tool/call). agy: a panel tool, served
// by the session's MCP server.
export interface CodexTool {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  reply: string;
  success?: boolean;
}

export interface Fixture {
  description: string;
  model?: string;
  // Extra options for the recording: Claude SDK options (e.g.
  // perTaskStopAffordance), codex thread/start params, Cursor agent options
  // (local.customTools).
  options?: Record<string, unknown>;
  // Codex, agy: the panel's tools, and the instructions that go with them.
  tools?: CodexTool[];
  instructions?: string;
  // Files materialised in the recording cwd (skills, images).
  files?: Record<string, string | { base64: string }>;
  // The backend's API calls go to a local stand-in instead of Anthropic or
  // OpenAI. "usage-limit" refuses each one as a spent usage limit does, so a
  // limit is recorded without spending the account's.
  api?: "usage-limit";
  steps: Step[];
  verify?: (replay: Replay) => void;
}

// A fixture's tools as the panel's: JSON Schema properties of strings and
// numbers, all the fixtures use.
export function panelTools(tools: CodexTool[], instructions?: string): PanelToolset {
  return {
    instructions: instructions ?? "Panel tools of a recorded fixture.",
    tools: tools.map((t) => {
      const props = (t.inputSchema.properties ?? {}) as Record<string, { type: string }>;
      const required = new Set((t.inputSchema.required ?? []) as string[]);
      const shape: Record<string, z.ZodType> = {};
      for (const [k, p] of Object.entries(props)) {
        const type = p.type === "number" ? z.number() : z.string();
        shape[k] = required.has(k) ? type : type.optional();
      }
      return {
        name: t.name,
        description: t.description,
        shape,
        handler: () =>
          t.success === false ? Promise.reject(new Error(t.reply)) : Promise.resolve(t.reply),
      };
    }),
  };
}

// What a tape keeps of a frame or a request: strings cut at 400
// characters, base64 payloads replaced (scripts/capture-sdk.ts). A replay
// compares what the session writes the same way.
export function tapeTrim(v: unknown): unknown {
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
  if (Array.isArray(v)) return v.map(tapeTrim);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "data" && typeof val === "string" && val.length > 100)
        o[k] = `<base64 ${val.length}>`;
      else o[k] = tapeTrim(val);
    }
    return o;
  }
  return v;
}

export const fixture = (f: Fixture): Fixture => f;
export const send = (text: string): Step => ({ op: "send", text });
export const requeued = (text: string): Step => ({ op: "send", text, requeued: true });
export const wait = (until: "result" | "idle" | number | { frame: string }): Step => ({
  op: "wait",
  for: until,
});
export const end = (): Step => ({ op: "end" });
export const abort = (): Step => ({ op: "abort" });
export const interrupt = (): Step => ({ op: "interrupt" });
export const compact = (): Step => ({ op: "compact" });
export const stopTask = (match: { type?: string; ambient?: boolean }): Step => ({
  op: "stopTask",
  match,
});

export const DEFAULT_MODEL: Record<Backend, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-6-luna",
  cursor: "cursor/composer-2.5",
  agy: "agy/gemini-3.8-flash",
};
export const RECORD_CWD = "/tmp/sdk-capture";
// agy: the thought level a recording runs at (the replay's agent too, as
// the requests setting it depend on it).
export const RECORD_EFFORT: Partial<Record<Backend, string>> = { agy: "low" };

export interface Header {
  backend: Backend;
  fixture: string;
  description: string;
  model: string;
  cli?: string;
  recordedAt: string;
}

export type Entry = { t: number } & (
  | { step: Step & { i: number } }
  | { frame: unknown }
  // Codex, agy: a JSON-RPC message the recorder sent to the backend.
  | { sent: unknown }
  | { error: string }
  // The backend's event stream closed (process exit).
  | { close: true }
  // A control request the recorder made (interrupt, stop_task) and its answer;
  // agy: "idleCheck", the session looking at what agy did while idle.
  | { control: { op: string; taskId?: string; response?: unknown; error?: string } }
);

export interface Recording {
  header: Header;
  entries: Entry[];
}

// Card lifecycle events fold into their start; the kinds a reader sees.
export const kinds = (evs: StreamEvent[]): string[] =>
  evs
    .filter((e) => e.kind !== "subagent_done" && e.kind !== "subagent_progress")
    .map((e) => e.kind);

export const agentMessages = (r: Replay): Message[] => r.messages.filter((m) => m.kind === "agent");
