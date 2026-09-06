// The fixture script: what a recorded interaction does and why it exists.
// No test or SDK dependencies, so scripts/capture-sdk.ts can load fixtures
// under plain node.
import type { Message } from "../../src/task";
import type { StreamEvent, UsageStats } from "../../src/claude-session";
import type { ContextUsage } from "../../src/claude-session";

export type Backend = "claude" | "codex";

export type Step =
  | { op: "send"; text: string }
  // Recording pacing only: "result" = the turn's result frame arrived,
  // "idle" = result and no live background task, a number = milliseconds.
  | { op: "wait"; for: "result" | "idle" | number }
  // End the backend process (a server restart); the next send resumes.
  | { op: "end" }
  // The user's Stop button mid-turn.
  | { op: "abort" };

export interface Replay {
  messages: Message[];
  events: StreamEvent[];
  states: string[];
  // Every session handle the workspace created, in order (a restart adds one).
  sessions: { sessionId: string | null; usage: UsageStats }[];
}

export interface Fixture {
  description: string;
  model?: string;
  // Files materialised in the recording cwd (skills, images).
  files?: Record<string, string | { base64: string }>;
  steps: Step[];
  verify?: (replay: Replay) => void;
}

export const fixture = (f: Fixture): Fixture => f;
export const send = (text: string): Step => ({ op: "send", text });
export const wait = (until: "result" | "idle" | number): Step => ({ op: "wait", for: until });
export const end = (): Step => ({ op: "end" });
export const abort = (): Step => ({ op: "abort" });

export const DEFAULT_MODEL: Record<Backend, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-6-astra",
};
export const RECORD_CWD = "/tmp/sdk-capture";

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
  | { error: string }
  // The backend's event stream closed (process exit, or codex's per-turn
  // stream ending).
  | { close: true }
  // Codex: the rollout's context snapshot after a turn.
  | { rollout: ContextUsage & { threadId: string } }
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
