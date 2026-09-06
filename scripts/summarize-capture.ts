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

function codexFrame(m: Obj, parts: string[]): void {
  parts.push(str(m.type));
  const item = obj(m.item);
  if (item.type) parts.push(`${str(item.type)}#${tail(item.id)}`);
  if (item.command) parts.push(`cmd=${JSON.stringify(str(item.command).slice(0, 50))}`);
  if (item.exit_code != null) parts.push(`exit=${str(item.exit_code)}`);
  if (item.text) parts.push(`text=${JSON.stringify(str(item.text).slice(0, 60))}`);
  if (m.usage) parts.push(`usage=${JSON.stringify(m.usage)}`);
  if (m.error) parts.push(`error=${JSON.stringify(m.error)}`);
  if (m.message) parts.push(`message=${JSON.stringify(m.message)}`);
}

for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const header = obj(obj(JSON.parse(lines[0])).header);
  console.log(`== ${file}  ${str(header.backend)} ${str(header.model)} cli=${str(header.cli)}`);
  console.log(`   ${str(header.description)}`);
  for (const line of lines.slice(1)) {
    const e = obj(JSON.parse(line));
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
      else claudeFrame(obj(e.frame), parts);
    } else if (e.error) parts.push(`!! error ${str(e.error)}`);
    else if (e.close) parts.push("-- stream closed");
    else if (e.rollout) parts.push(`rollout ${JSON.stringify(e.rollout)}`);
    console.log(parts.join("  "));
  }
}
