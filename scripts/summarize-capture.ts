// Compact view of a capture: one line per frame with the fields that drive
// the session mapping. Usage: node scripts/summarize-capture.ts file.jsonl
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

function summarizeFrame(t: unknown, m: Obj): string {
  const parts = [
    String(t).padStart(6) + "ms",
    str(m.type) + (m.subtype ? "/" + str(m.subtype) : ""),
  ];
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
  }
  return parts.join("  ");
}

for (const file of process.argv.slice(2)) {
  console.log(`== ${file}`);
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const { t, msg } = obj(JSON.parse(line));
    console.log(summarizeFrame(t, obj(msg)));
  }
}
