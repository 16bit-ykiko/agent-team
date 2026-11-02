// Compact view of a snap recording: one line per entry with the fields that
// drive the session mapping. Usage: npm run summarize -- <file.jsonl>
import fs from "node:fs";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const tail = (v: unknown, n = 6): string => str(v).slice(-n);

const SYSTEM_FIELDS = [
  "task_id",
  "tool_use_id",
  "task_type",
  "subagent_type",
  "is_backgrounded",
  "spawn_depth",
  "skip_transcript",
  "ambient",
  "status",
  "description",
  "summary",
  "last_tool_name",
];

function blockLabel(b: Obj): string {
  let s = str(b.type);
  if (b.name) s += ":" + str(b.name);
  if (b.tool_use_id) s += "->" + tail(b.tool_use_id);
  if (b.id) s += "#" + tail(b.id);
  return s;
}

function claudeFrame(m: Obj, parts: string[]): void {
  parts.push(str(m.type) + (m.subtype ? "/" + str(m.subtype) : ""));
  if (m.parent_tool_use_id) parts.push(`parent=${tail(m.parent_tool_use_id)}`);
  if (m.type === "assistant" || m.type === "user") {
    const c = obj(m.message).content;
    const blocks = Array.isArray(c)
      ? c.map((b) => blockLabel(obj(b)))
      : [typeof c === "string" ? `str(${c.slice(0, 40)})` : typeof c];
    parts.push(blocks.join(","));
    for (const k of ["isSynthetic", "isReplay", "shouldQuery", "isMeta"])
      if (m[k] != null) parts.push(`${k}=${str(m[k])}`);
    if (m.type === "user" && Array.isArray(c)) {
      const text = c
        .map(obj)
        .filter((b) => b.type === "text")
        .map((b) => str(b.text).slice(0, 60))
        .join(" | ");
      if (text) parts.push(`text="${text}"`);
    }
  } else if (m.type === "stream_event") {
    const e = obj(m.event);
    const delta = obj(e.delta).type;
    const block = obj(e.content_block).type;
    parts.push(str(e.type) + (delta ? ":" + str(delta) : "") + (block ? ":" + str(block) : ""));
  } else if (m.type === "system") {
    for (const k of SYSTEM_FIELDS) {
      const v = m[k];
      if (v != null)
        parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v.slice(0, 50)) : str(v)}`);
    }
    if (Array.isArray(m.tasks))
      parts.push(
        "tasks=" +
          JSON.stringify(
            m.tasks
              .map(obj)
              .map((x) => ({ id: tail(x.task_id), type: x.task_type, amb: x.ambient })),
          ),
      );
    if (m.patch) parts.push("patch=" + JSON.stringify(m.patch));
  } else if (m.type === "result") {
    parts.push(`subtype=${str(m.subtype)} turns=${str(m.num_turns)}`);
    if (m.origin) parts.push(`origin=${JSON.stringify(m.origin)}`);
  }
}

// The thread a recording started; a subagent's frames name their own.
let mainThread: unknown;

// A JSON-RPC message of `codex app-server`, either way.
function codexFrame(m: Obj, parts: string[]): void {
  const p = obj(m.params);
  mainThread ??= p.threadId;
  if (m.method) parts.push(str(m.method) + (m.id != null ? ` [req ${str(m.id)}]` : ""));
  else parts.push(`[res ${str(m.id)}]`);
  if (p.threadId && p.threadId !== mainThread) parts.push(`@sub:${tail(p.threadId)}`);
  const item = obj(p.item);
  if (item.type) parts.push(`${str(item.type)}#${tail(item.id)}`);
  if (item.status) parts.push(`status=${str(item.status)}`);
  if (item.command) parts.push(`cmd=${JSON.stringify(str(item.command).slice(0, 50))}`);
  if (item.exitCode != null) parts.push(`exit=${str(item.exitCode)}`);
  if (item.tool) parts.push(`tool=${str(item.namespace ?? "")}.${str(item.tool)}`);
  if (item.text) parts.push(`text=${JSON.stringify(str(item.text).slice(0, 60))}`);
  if (Array.isArray(item.summary) && item.summary.length)
    parts.push(`summary=${JSON.stringify(str(item.summary).slice(0, 60))}`);
  if (Array.isArray(item.content) && item.content.length)
    parts.push(`content=${JSON.stringify(str(item.content).slice(0, 60))}`);
  if (p.itemId) parts.push(`#${tail(p.itemId)}`);
  if (p.delta != null) parts.push(JSON.stringify(str(p.delta).slice(0, 60)));
  const turn = obj(p.turn);
  if (turn.id) parts.push(`turn=${tail(turn.id)} ${str(turn.status)}`);
  if (turn.error) parts.push(`error=${JSON.stringify(turn.error)}`);
  if (p.error) parts.push(`error=${JSON.stringify(p.error)}`);
  if (p.willRetry != null) parts.push(`willRetry=${str(p.willRetry)}`);
  const usage = obj(p.tokenUsage);
  if (usage.last)
    parts.push(`last=${str(obj(usage.last).totalTokens)} window=${str(usage.modelContextWindow)}`);
  if (p.rateLimits) parts.push(`rateLimits=${JSON.stringify(p.rateLimits).slice(0, 160)}`);
  if (p.status) parts.push(`status=${JSON.stringify(p.status)}`);
  if (m.method === "item/tool/call")
    parts.push(
      `${str(p.namespace)}.${str(p.tool)} ${JSON.stringify(p.arguments)} thread=${tail(p.threadId)}`,
    );
  if (m.method === "turn/start" || m.method === "turn/steer") {
    const text = (Array.isArray(p.input) ? p.input : []).map((i) => str(obj(i).text)).join(" ");
    parts.push(JSON.stringify(text.slice(0, 60)));
  }
  if (m.result !== undefined) parts.push(JSON.stringify(m.result).slice(0, 200));
  if (m.error) parts.push(`error=${JSON.stringify(m.error)}`);
}

const DELTA = /\/(delta|outputDelta|summaryTextDelta|textDelta)$/;

// Cursor frames are tagged by source (see the recorder's cursorDriver).
function cursorFrame(f: Obj, parts: string[]): void {
  const [source] = Object.keys(f);
  const v = obj(f[source]);
  parts.push(source);
  if (source === "delta" || source === "message") {
    parts.push(str(v.type));
    const call = obj(v.toolCall);
    const name = call.type ?? v.name;
    if (name) parts.push(`${str(name)}#${tail(v.callId ?? v.call_id)}`);
    if (v.status) parts.push(`status=${str(v.status)}`);
    if (typeof v.text === "string") parts.push(JSON.stringify(v.text.slice(0, 60)));
    if (v.usage) parts.push(`usage=${JSON.stringify(v.usage)}`);
    const result = obj(call.result ?? v.result);
    if (result.status) parts.push(`result=${str(result.status)}`);
  } else if (source === "step") {
    parts.push(str(v.type));
  } else if (source === "status") {
    parts.push(str(f.status));
  } else {
    parts.push(JSON.stringify(v).slice(0, 160));
  }
}

for (const file of process.argv.slice(2)) {
  mainThread = undefined;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const header = obj(obj(JSON.parse(lines[0])).header);
  console.log(`== ${file}  ${str(header.backend)} ${str(header.model)} cli=${str(header.cli)}`);
  console.log(`   ${str(header.description)}`);
  // Consecutive deltas of one item fold into a line.
  type Run = { key: string; t: unknown; method: string; n: number; text: string };
  let run = null as Run | null;
  const flush = () => {
    if (!run) return;
    const head = String(run.t).padStart(6) + "ms";
    console.log(
      `${head}  ${run.method} ×${run.n}  ${run.key.split(" ")[1]}  ${JSON.stringify(run.text.slice(0, 80))}`,
    );
    run = null;
  };
  for (const line of lines.slice(1)) {
    const e = obj(JSON.parse(line));
    const frame = obj(e.frame);
    const p = obj(frame.params);
    if (
      header.backend === "codex" &&
      typeof frame.method === "string" &&
      DELTA.test(frame.method)
    ) {
      const key = `${frame.method} #${tail(p.itemId)}`;
      if (run?.key !== key) {
        flush();
        run = { key, t: e.t, method: frame.method, n: 0, text: "" };
      }
      run.n++;
      run.text += str(p.delta);
      continue;
    }
    flush();
    const parts = [String(e.t).padStart(6) + "ms"];
    if (e.step) {
      const s = obj(e.step);
      parts.push(
        `>> step ${str(s.i)} ${str(s.op)}` +
          (s.text ? ` ${JSON.stringify(str(s.text).slice(0, 70))}` : "") +
          (s.for != null ? ` ${str(s.for)}` : ""),
      );
    } else if (e.frame) {
      if (header.backend === "codex") codexFrame(obj(e.frame), parts);
      else if (header.backend === "cursor") cursorFrame(obj(e.frame), parts);
      else claudeFrame(obj(e.frame), parts);
    } else if (e.sent) {
      parts.push(">>");
      codexFrame(obj(e.sent), parts);
    } else if (e.error) parts.push(`!! error ${str(e.error)}`);
    else if (e.close) parts.push("-- stream closed");
    else if (e.control) parts.push(`<< control ${JSON.stringify(e.control)}`);
    console.log(parts.join("  "));
  }
  flush();
}
