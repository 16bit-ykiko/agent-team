// Capture raw @anthropic-ai/claude-agent-sdk message streams for real
// scenarios (foreground/background shells, subagents, skills, images) so the
// session mapping is written against what the CLI actually emits.
// Usage: node scripts/capture-sdk.ts <scenario ...>   (a few at a time, never all)
// Output: ~/.cache/agent-team-captures/<scenario>.jsonl
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const MODEL = process.env.CAPTURE_MODEL ?? "claude-sonnet-5";
const CWD = process.env.CAPTURE_CWD ?? "/tmp/sdk-capture";
const OUT = path.join(os.homedir(), ".cache", "agent-team-captures");
const IMAGE = process.env.CAPTURE_IMAGE ?? path.join(CWD, "sample.png");

interface Scenario {
  prompts: string[];
  // End the session right after the first result even if background tasks
  // are still running, then resume it with these prompts in a new session.
  resume?: string[];
}

const SCENARIOS: Record<string, string[] | Scenario> = {
  "bash-quick": ["Run `echo hi` with the Bash tool, then reply with the single word done."],
  "bash-long": [
    "Run `sleep 8; echo slow` with the Bash tool in the foreground (do NOT use run_in_background), wait for it, then reply with the single word done.",
  ],
  "bash-bg": [
    "Run `sleep 6; echo finished` with the Bash tool with run_in_background set to true. Do not wait for it and do not poll it; reply with the single word started right away.",
  ],
  agent: [
    "Use the Agent tool (subagent_type general-purpose, foreground) with this prompt: 'Run `echo sub` with Bash and report its output.' Then reply with what the subagent reported.",
  ],
  "agent-bg": [
    "Use the Agent tool (subagent_type general-purpose) with run_in_background set to true and this prompt: 'Run `sleep 4; echo bgsub` with Bash and report its output.' Reply with the single word started right away; do not wait or poll.",
  ],
  "nested-agent": [
    "Use the Agent tool (subagent_type general-purpose) with this prompt: 'Use the Agent tool with subagent_type Explore and the prompt \"List the files in the current directory with Bash ls and report them\", then report what it found.' Then reply with the final report in one line.",
  ],
  skill: ["/hello"],
  "skill-tool": [
    "Use the Skill tool to invoke the skill named hello, then reply with what it said.",
  ],
  image: [
    `Read the image file ${IMAGE} with the Read tool and describe it in at most eight words.`,
  ],
  "two-turns": ["Reply with the single word one.", "Reply with the single word two."],
  "resume-orphan-bg": {
    prompts: [
      "Run `sleep 120; echo late` with the Bash tool with run_in_background set to true. Do not wait for it and do not poll it; reply with the single word started right away.",
    ],
    resume: ["Reply with the single word two."],
  },
};

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

function inputStream() {
  let resolve: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  const buffer: SDKUserMessage[] = [];
  let done = false;
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          const head = buffer.shift();
          if (head) return Promise.resolve({ value: head, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => (resolve = r));
        },
      };
    },
  };
  const wake = (r: IteratorResult<SDKUserMessage>) => {
    const fn = resolve;
    resolve = null;
    fn?.(r);
  };
  return {
    iterable,
    push(msg: SDKUserMessage) {
      if (resolve) wake({ value: msg, done: false });
      else buffer.push(msg);
    },
    end() {
      done = true;
      wake({ value: undefined, done: true });
    },
  };
}

interface SessionOpts {
  prompts: string[];
  resume?: string;
  endAfterFirstResult?: boolean;
}

// Returns the session id so a follow-up session can resume it.
async function runSession(out: fs.WriteStream, t0: number, opts: SessionOpts): Promise<string> {
  const { prompts } = opts;
  const log = (msg: unknown) =>
    out.write(JSON.stringify({ t: Date.now() - t0, msg: trim(msg) }) + "\n");
  log({ type: "capture_session", resume: opts.resume ?? null });
  const input = inputStream();
  const abort = new AbortController();
  let sessionId = "";
  const q = query({
    prompt: input.iterable,
    options: {
      cwd: CWD,
      model: MODEL,
      abortController: abort,
      ...(opts.resume && { resume: opts.resume }),
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
  const pending = [...prompts];
  let bg = 0;
  let results = 0;
  let lastAt = Date.now();
  const send = () => {
    const text = pending.shift();
    if (text == null) return;
    input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  };
  send();
  const deadline = Date.now() + 150_000;
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastAt;
    const turnDone =
      results > 0 && pending.length === 0 && (bg === 0 || opts.endAfterFirstResult === true);
    if ((turnDone && idle > 4000) || Date.now() > deadline) {
      clearInterval(watchdog);
      input.end();
      setTimeout(() => abort.abort(), 1500);
    }
  }, 500);
  try {
    for await (const msg of q) {
      lastAt = Date.now();
      log(msg);
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
        bg = msg.tasks.filter((t) => !t.ambient).length;
      }
      if (msg.type === "result") {
        results++;
        if (pending.length) setTimeout(send, 300);
      }
    }
  } catch (e) {
    log({ type: "capture_error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    clearInterval(watchdog);
  }
  return sessionId;
}

async function run(name: string, scenario: string[] | Scenario) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.jsonl`);
  const out = fs.createWriteStream(file);
  const t0 = Date.now();
  const sc = Array.isArray(scenario) ? { prompts: scenario } : scenario;
  const sessionId = await runSession(out, t0, {
    prompts: sc.prompts,
    endAfterFirstResult: sc.resume !== undefined,
  });
  if (sc.resume) {
    await new Promise((r) => setTimeout(r, 3000));
    await runSession(out, t0, { prompts: sc.resume, resume: sessionId });
  }
  out.end();
  const frames = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  console.log(`${name}: ${frames} frames -> ${file}`);
}

// Each scenario is a real session on the user's account; bursts of sessions
// risk an account ban, so scenarios run one at a time with a pause between.
const PAUSE_MS = 30_000;
const MAX_PER_RUN = 4;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(`pick scenarios (max ${MAX_PER_RUN} per run): ${Object.keys(SCENARIOS).join(" ")}`);
  process.exit(2);
}
if (args.length > MAX_PER_RUN) {
  console.error(`too many scenarios (${args.length}); capture at most ${MAX_PER_RUN} per run`);
  process.exit(2);
}
let first = true;
for (const n of args) {
  const scenario = SCENARIOS[n];
  if (!scenario) {
    console.error("unknown scenario", n);
    continue;
  }
  if (!first) {
    console.log(`pausing ${PAUSE_MS / 1000}s before ${n}`);
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  first = false;
  await run(n, scenario);
}
