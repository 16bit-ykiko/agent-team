import type { Message } from "./task";
import type { StreamEvent } from "./claude-session";

// History pages carry only what the collapsed view needs: kinds, chips,
// counts, banners. Bodies (thinking text, tool output, subagent transcripts)
// are fetched per message when the user expands something. This keeps a
// 50-message page in the tens of KB instead of megabytes.

const FIRST_LINE_MAX = 200;
const BANNER_MAX = 600;

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > FIRST_LINE_MAX ? line.slice(0, FIRST_LINE_MAX) + "…" : line;
}

export function summarizeEvent(e: StreamEvent): StreamEvent {
  const base: StreamEvent = { kind: e.kind, content: "" };
  if (e.toolName) base.toolName = e.toolName;
  if (e.level) base.level = e.level;
  if (e.toolUseId) base.toolUseId = e.toolUseId;
  if (e.contentOffset != null) base.contentOffset = e.contentOffset;
  if (e.step != null) base.step = e.step;
  if (e.isMarkdown) base.isMarkdown = true;
  if (e.toolResultIsMarkdown) base.toolResultIsMarkdown = true;

  switch (e.kind) {
    case "tool_use":
      base.content = firstLine(e.content ?? "");
      base.bodyLength = (e.content ?? "").length;
      if (e.toolResult != null) base.resultLength = e.toolResult.length;
      break;
    case "compact":
    case "notice":
    case "retry":
    case "error": {
      const text = e.content ?? "";
      base.content = text.length > BANNER_MAX ? text.slice(0, BANNER_MAX) + "…" : text;
      if (text.length > BANNER_MAX) base.contentLength = text.length;
      break;
    }
    case "subagent_start":
    case "subagent_progress":
    case "subagent_done":
      if (e.subagent) {
        const sa = e.subagent;
        base.subagent = {
          taskId: sa.taskId,
          description: sa.description,
          ...(sa.agentType && { agentType: sa.agentType }),
          ...(sa.status && { status: sa.status }),
          ...(sa.lastTool && { lastTool: sa.lastTool }),
          ...(sa.usage && { usage: sa.usage }),
          eventCount: sa.events?.length ?? sa.eventCount ?? 0,
          ...(sa.prompt && { hasPrompt: true }),
          ...(sa.summary && { summaryLength: sa.summary.length }),
        };
      }
      break;
    default:
      // thinking, text, tool_result and anything else: body on demand.
      base.contentLength = (e.content ?? "").length;
      break;
  }
  return base;
}

export function summarizeMessage(m: Message): Message {
  if (!m.events?.length) return m;
  return { ...m, events: m.events.map(summarizeEvent), detail: "summary" };
}

export function summarizeMessages(messages: Message[]): Message[] {
  return messages.map(summarizeMessage);
}
