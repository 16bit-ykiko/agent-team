// Capture raw @anthropic-ai/claude-agent-sdk message streams for real
// scenarios (foreground/background shells, subagents, skills, images) so the
// session mapping is written against what the CLI actually emits.
// Usage: node scripts/capture-sdk.mjs [scenario ...]   (default: all)
// Output: ~/.cache/agent-team-captures/<scenario>.jsonl
import fs from "fs";
import os from "os";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MODEL = process.env.CAPTURE_MODEL ?? "claude-sonnet-5";
const CWD = process.env.CAPTURE_CWD ?? "/tmp/sdk-capture";
const OUT = path.join(os.homedir(), ".cache", "agent-team-captures");
const IMAGE = "/home/ykiko/workspace/agent-team/uploads/1788704744168-shjqyi.png";

const SCENARIOS = {
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
};

function trim(v, depth = 0) {
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
  if (Array.isArray(v)) return v.map((x) => trim(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "data" && typeof val === "string" && val.length > 100)
        o[k] = `<base64 ${val.length}>`;
      else o[k] = trim(val, depth + 1);
    }
    return o;
  }
  return v;
}

function inputStream() {
  let resolve = null;
  const buffer = [];
  let done = false;
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => (resolve = r));
        },
      };
    },
  };
  return {
    iterable,
    push(msg) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else buffer.push(msg);
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
  };
}

async function run(name, prompts) {
  const file = path.join(OUT, `${name}.jsonl`);
  const out = fs.createWriteStream(file);
  const t0 = Date.now();
  const log = (msg) => out.write(JSON.stringify({ t: Date.now() - t0, msg: trim(msg) }) + "\n");
  const input = inputStream();
  const abort = new AbortController();
  const q = query({
    prompt: input.iterable,
    options: {
      cwd: CWD,
      model: MODEL,
      abortController: abort,
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
  let pending = [...prompts];
  let bg = 0;
  let results = 0;
  let lastAt = Date.now();
  const send = () => {
    const text = pending.shift();
    if (text == null) return false;
    input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    return true;
  };
  send();
  const deadline = Date.now() + 150_000;
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastAt;
    const turnDone = results > 0 && pending.length === 0 && bg === 0;
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
      if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
        bg = (msg.tasks ?? []).filter((t) => !t.ambient).length;
      }
      if (msg.type === "result") {
        results++;
        if (pending.length) setTimeout(send, 300);
      }
    }
  } catch (e) {
    log({ type: "capture_error", message: String(e?.message ?? e) });
  } finally {
    clearInterval(watchdog);
    out.end();
  }
  console.log(
    `${name}: ${fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length} frames -> ${file}`,
  );
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
for (const n of names) {
  if (!SCENARIOS[n]) {
    console.error("unknown scenario", n);
    continue;
  }
  await run(n, SCENARIOS[n]);
}
