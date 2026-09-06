// Record a snap fixture against the real backend: runs the fixture's steps
// (service/tests/snap/<backend>/<name>.ts) and writes the raw SDK frames,
// interleaved with step markers, to <name>.jsonl next to it.
//
// Usage: npm run capture -- <claude|codex> <name...>
//
// Every run is a real session on the user's account. Bursts of sessions
// risk an account ban: at most a few fixtures per run, one at a time, with
// a pause between them. Never loop this.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Backend,
  type Entry,
  type Fixture,
  type Header,
  type Step,
  DEFAULT_MODEL,
  RECORD_CWD,
} from "../service/tests/snap/fixture.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, "service", "tests", "snap");
const PAUSE_MS = 30_000;
const MAX_PER_RUN = 4;
const STEP_DEADLINE_MS = 150_000;

function trim(v: unknown): unknown {
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
  if (Array.isArray(v)) return v.map(trim);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "data" && typeof val === "string" && val.length > 100)
        o[k] = `<base64 ${val.length}>`;
      else o[k] = trim(val);
    }
    return o;
  }
  return v;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Tape {
  entries: Entry[] = [];
  private t0 = Date.now();
  cli: string | undefined;
  add(e: Omit<Entry, "t">): void {
    this.entries.push({ t: Date.now() - this.t0, ...e } as Entry);
  }
  frame(f: unknown): void {
    this.add({ frame: trim(f) });
  }
}

interface Driver {
  send(text: string): Promise<void>;
  wait(until: "result" | "idle" | number): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
  cli(): string | undefined;
}

// --- claude -----------------------------------------------------------------

async function claudeDriver(tape: Tape, model: string): Promise<Driver> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type UserMsg = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
  let sessionId: string | undefined;
  let cli: string | undefined;
  let active: {
    push(m: UserMsg): void;
    endInput(): void;
    abort: AbortController;
    finished: Promise<void>;
    ended: boolean;
  } | null = null;
  let results = 0;
  let bg = 0;
  let lastAt = Date.now();

  const start = () => {
    let resolve: ((r: IteratorResult<UserMsg>) => void) | null = null;
    const buffer: UserMsg[] = [];
    let done = false;
    const wake = (r: IteratorResult<UserMsg>) => {
      const fn = resolve;
      resolve = null;
      fn?.(r);
    };
    const input: AsyncIterable<UserMsg> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const head = buffer.shift();
          if (head) return Promise.resolve({ value: head, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => (resolve = r));
        },
      }),
    };
    const abort = new AbortController();
    const q = query({
      prompt: input,
      options: {
        cwd: RECORD_CWD,
        model,
        abortController: abort,
        ...(sessionId && { resume: sessionId }),
        systemPrompt: { type: "preset", preset: "claude_code" },
        skills: "all",
        includePartialMessages: true,
        forwardSubagentText: true,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["AskUserQuestion", "CronCreate", "CronDelete", "CronList"],
      },
    });
    const self = {
      push: (m: UserMsg) => (resolve ? wake({ value: m, done: false }) : buffer.push(m)),
      endInput: () => {
        done = true;
        wake({ value: undefined, done: true });
      },
      abort,
      ended: false,
      finished: Promise.resolve(),
    };
    self.finished = (async () => {
      try {
        for await (const msg of q) {
          lastAt = Date.now();
          tape.frame(msg);
          if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
          if (msg.type === "system" && msg.subtype === "init") cli = msg.claude_code_version;
          if (msg.type === "system" && msg.subtype === "background_tasks_changed")
            bg = msg.tasks.filter((t) => !t.ambient).length;
          if (msg.type === "result") results++;
        }
      } catch (e) {
        if (!self.ended) tape.add({ error: e instanceof Error ? e.message : String(e) });
      }
      tape.add({ close: true });
      active = null;
    })();
    return self;
  };

  return {
    async send(text) {
      active ??= start();
      results = 0;
      active.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      await sleep(50);
    },
    async wait(until) {
      if (typeof until === "number") return sleep(until);
      const deadline = Date.now() + STEP_DEADLINE_MS;
      while (Date.now() < deadline) {
        const quiet = Date.now() - lastAt;
        if (until === "result" && results > 0 && quiet > 300) return;
        if (until === "idle" && results > 0 && bg === 0 && quiet > 4000) return;
        await sleep(200);
      }
      throw new Error(`wait(${until}) timed out`);
    },
    async end() {
      if (!active) return;
      active.ended = true;
      active.endInput();
      await sleep(500);
      active.abort.abort();
      await active.finished;
    },
    async abort() {
      if (!active) return;
      active.ended = true;
      active.abort.abort();
      await active.finished;
    },
    cli: () => cli,
  };
}

// --- codex ------------------------------------------------------------------

async function codexDriver(tape: Tape, model: string): Promise<Driver> {
  const { Codex } = await import("@openai/codex-sdk");
  const { codexHome, findRollout, readRolloutContext } =
    await import("../service/src/codex-session.ts");
  const bin = execSync("which codex", { encoding: "utf-8" }).trim();
  const version = execSync(`${bin} --version`, { encoding: "utf-8" }).trim();
  const codex = new Codex({ codexPathOverride: bin });
  let threadId: string | null = null;
  let abort: AbortController | null = null;
  const options = {
    workingDirectory: RECORD_CWD,
    sandboxMode: "danger-full-access" as const,
    approvalPolicy: "never" as const,
    skipGitRepoCheck: true,
    model,
  };
  return {
    async send(text) {
      const thread = threadId ? codex.resumeThread(threadId, options) : codex.startThread(options);
      abort = new AbortController();
      try {
        const { events } = await thread.runStreamed(text, { signal: abort.signal });
        for await (const ev of events) {
          tape.frame(ev);
          if (ev.type === "thread.started") threadId = ev.thread_id;
        }
      } catch (e) {
        if (!abort.signal.aborted) tape.add({ error: e instanceof Error ? e.message : String(e) });
      }
      tape.add({ close: true });
      if (threadId) {
        const file = findRollout(codexHome(), threadId);
        const ctx = file ? readRolloutContext(file) : undefined;
        if (ctx) tape.add({ rollout: { threadId, ...ctx } });
      }
    },
    wait: () => Promise.resolve(),
    end: () => Promise.resolve(),
    abort() {
      abort?.abort();
      return Promise.resolve();
    },
    cli: () => version,
  };
}

// --- run --------------------------------------------------------------------

function materialize(files: Fixture["files"]): void {
  fs.mkdirSync(RECORD_CWD, { recursive: true });
  for (const [rel, content] of Object.entries(files ?? {})) {
    const file = path.join(RECORD_CWD, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof content === "string") fs.writeFileSync(file, content);
    else fs.writeFileSync(file, Buffer.from(content.base64, "base64"));
  }
}

async function record(backend: Backend, name: string): Promise<void> {
  const file = path.join(SNAP, backend, `${name}.ts`);
  const fixture = ((await import(file)) as { default: Fixture }).default;
  const model = fixture.model ?? DEFAULT_MODEL[backend];
  materialize(fixture.files);
  const tape = new Tape();
  const driver =
    backend === "claude" ? await claudeDriver(tape, model) : await codexDriver(tape, model);
  const run = async (step: Step) => {
    switch (step.op) {
      case "send":
        return driver.send(step.text);
      case "wait":
        return driver.wait(step.for);
      case "end":
        return driver.end();
      case "abort":
        return driver.abort();
    }
  };
  for (const [i, step] of fixture.steps.entries()) {
    tape.add({ step: { i, ...step } });
    await run(step);
  }
  await driver.end();
  const header: Header = {
    backend,
    fixture: name,
    description: fixture.description,
    model,
    cli: driver.cli(),
    recordedAt: new Date().toISOString(),
  };
  const out = path.join(SNAP, backend, `${name}.jsonl`);
  fs.writeFileSync(
    out,
    [JSON.stringify({ header }), ...tape.entries.map((e) => JSON.stringify(e))].join("\n") + "\n",
  );
  console.log(`${backend}/${name}: ${tape.entries.length} entries -> ${path.relative(ROOT, out)}`);
}

const [backend, ...names] = process.argv.slice(2);
if ((backend !== "claude" && backend !== "codex") || names.length === 0) {
  console.error("usage: npm run capture -- <claude|codex> <name...>");
  process.exit(2);
}
if (names.length > MAX_PER_RUN) {
  console.error(`too many fixtures (${names.length}); record at most ${MAX_PER_RUN} per run`);
  process.exit(2);
}
for (const [i, name] of names.entries()) {
  if (i > 0) {
    console.log(`pausing ${PAUSE_MS / 1000}s before ${name}`);
    await sleep(PAUSE_MS);
  }
  await record(backend, name);
}
process.exit(0);
