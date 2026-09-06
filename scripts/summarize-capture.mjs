// Compact view of a capture: one line per frame with the fields that drive
// the session mapping. Usage: node scripts/summarize-capture.mjs file.jsonl
import fs from "fs";
for (const file of process.argv.slice(2)) {
  console.log(`== ${file}`);
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const { t, msg: m } = JSON.parse(line);
    const parts = [String(t).padStart(6) + "ms", m.type + (m.subtype ? "/" + m.subtype : "")];
    if (m.parent_tool_use_id) parts.push(`parent=${m.parent_tool_use_id.slice(-6)}`);
    if (m.type === "assistant" || m.type === "user") {
      const c = m.message?.content;
      const blocks = Array.isArray(c)
        ? c.map(
            (b) =>
              b.type +
              (b.name ? ":" + b.name : "") +
              (b.tool_use_id ? "->" + b.tool_use_id.slice(-6) : "") +
              (b.id ? "#" + b.id.slice(-6) : ""),
          )
        : [typeof c === "string" ? `str(${c.slice(0, 40)})` : typeof c];
      parts.push(blocks.join(","));
      for (const k of ["isSynthetic", "isReplay", "shouldQuery", "isMeta"])
        if (m[k] != null) parts.push(`${k}=${m[k]}`);
      if (m.type === "user" && Array.isArray(c)) {
        const text = c
          .filter((b) => b.type === "text")
          .map((b) => b.text.slice(0, 60))
          .join(" | ");
        if (text) parts.push(`text="${text}"`);
      }
    } else if (m.type === "stream_event") {
      const e = m.event;
      parts.push(
        e.type +
          (e.delta?.type ? ":" + e.delta.type : "") +
          (e.content_block?.type ? ":" + e.content_block.type : ""),
      );
    } else if (m.type === "system") {
      for (const k of [
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
      ]) {
        if (m[k] != null)
          parts.push(`${k}=${typeof m[k] === "string" ? JSON.stringify(m[k].slice(0, 50)) : m[k]}`);
      }
      if (m.tasks)
        parts.push(
          "tasks=" +
            JSON.stringify(
              m.tasks.map((x) => ({ id: x.task_id.slice(-6), type: x.task_type, amb: x.ambient })),
            ),
        );
      if (m.patch) parts.push("patch=" + JSON.stringify(m.patch));
    } else if (m.type === "result") {
      parts.push(`subtype=${m.subtype} turns=${m.num_turns}`);
    }
    console.log(parts.join("  "));
  }
}
