import {
  useState,
  useCallback,
  useMemo,
  memo,
  Component,
  useEffect,
  createContext,
  useContext,
} from "react";
import type { ReactNode } from "react";
import type { Message, MessageOrigin, AgentInfo, StreamEvent } from "../state/useServer";
import { splitEvents, timelineBlocks } from "./events";
import { toolNameOf, toolSummary } from "../state/stream";
import { copySelectionAsMarkdown } from "./clipboard";
import { MdBlock, StreamingMdBlock } from "./markdown";
import { AgentAvatar, Avatar } from "../workspace/avatar";
import { shortModel, formatTokens, formatDuration, formatRunTime } from "../format";

function renderMentionContent(content: string, agents: AgentInfo[]) {
  const match = content.match(/^@(\S+)(\s+|$)/);
  if (!match) {
    return <MdBlock>{content}</MdBlock>;
  }
  const mentionName = match[1];
  const rest = content.slice(match[0].length);
  const mentioned = agents.find((a) => a.name === mentionName);
  return (
    <>
      <span
        className="mention-pill"
        style={mentioned ? { background: mentioned.color } : undefined}
      >
        @{mentionName}
      </span>
      {rest && <MdBlock>{rest}</MdBlock>}
    </>
  );
}

// The sender of a message another session delivered (the server names it
// the same way in quotes and forwards).
const ORIGIN_GLYPH: Record<MessageOrigin["role"], string> = {
  lead: "◆",
  peer: "◆",
  worker: "◇",
  panel: "▣",
};

export function originLabel(from: MessageOrigin): string {
  if (from.role === "lead") return "Lead";
  if (from.role === "panel") return `Panel · ${from.name}`;
  return from.role === "peer" ? `${from.name} · lead` : from.name;
}

// Banners that carry a whole prompt (a wake-up's text, a scheduled
// wake-up's instructions, a skill's body) start folded to their first line.
const FOLDING_LEVELS = new Set(["wakeup", "schedule", "skill"]);
const FOLD_OVER_CHARS = 160;
const BANNER_LABEL: Record<string, string> = {
  wakeup: "Woke up",
  schedule: "Scheduled",
  skill: "Skill",
  error: "Error",
};

export function bannerFirstLine(content: string): string {
  const line = (content ?? "").split("\n").find((l) => l.trim()) ?? "";
  const plain = line.replace(/[*_`#>]/g, "").trim();
  return plain.length > FOLD_OVER_CHARS ? plain.slice(0, FOLD_OVER_CHARS - 1) + "…" : plain;
}

export function bannerFolds(level: string, content: string): boolean {
  if (!FOLDING_LEVELS.has(level)) return false;
  const text = content ?? "";
  return text.trim().includes("\n") || text.length > FOLD_OVER_CHARS;
}

// Inline status line: compaction, CLI notices, API retries. Rendered as a
// sibling of the step box so it is visible without expanding anything.
export const BannerItem = memo(function BannerItem({
  ev,
  onLoadDetails,
}: {
  ev: StreamEvent;
  // Summary pages cap banner bodies; opening one fetches the full message.
  onLoadDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const level =
    ev.kind === "compact"
      ? "compact"
      : ev.kind === "retry"
        ? "retry"
        : ev.kind === "error"
          ? "error"
          : (ev.level ?? "notice");
  const truncated = (ev.contentLength ?? 0) > (ev.content ?? "").length;
  const icon =
    ev.kind === "compact"
      ? "⇢"
      : ev.kind === "retry"
        ? "↻"
        : level === "wakeup" || level === "schedule"
          ? "⏰"
          : level === "skill"
            ? "✦"
            : level === "warning" || level === "error"
              ? "!"
              : "i";
  const folds = bannerFolds(level, ev.content);
  const label = BANNER_LABEL[level];
  return (
    <div
      className={`banner banner-${level}${folds && !open ? " banner-folded" : ""}`}
      data-kind={ev.kind}
    >
      <span className="banner-icon">{icon}</span>
      <div className="banner-text">
        {label && <span className="banner-label">{label}</span>}
        {folds && !open ? (
          <span className="banner-first-line">{bannerFirstLine(ev.content)}</span>
        ) : ev.kind === "notice" || ev.kind === "error" ? (
          <MdBlock>{ev.content}</MdBlock>
        ) : (
          ev.content
        )}
      </div>
      {(folds || truncated) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (truncated) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
});

// Sessions and projects named in the chat (a panel action's target): their
// names as they are now, and a session opened on a click.
export interface SessionLinks {
  open?: (workspaceId: string) => void;
  nameOf?: (id: string) => string | undefined;
}
export const SessionLinkContext = createContext<SessionLinks>({});

const ACTION_LABEL: Record<string, string> = {
  start_session: "New session",
  message_session: "Message",
  message_project: "Message to project",
  stop_session: "Stopped",
  archive_session: "Archived",
  report_progress: "Progress to lead",
  finish_task: "Task finished",
};

// A panel call as the panel renders it (claude.ts formatPanelTool): the
// line after the tool's name (a title, an id), then the quoted text (a
// task, a message, a report).
function actionParts(content: string): { head: string; quote: string } {
  const lines = (content ?? "").split("\n");
  const head = lines[0]
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  const quote = lines
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
  return { head, quote };
}

// A panel call that changed something elsewhere, as a line of its own:
// what was done, to whom (the session opens on a click), the first line of
// what was sent, and whether it failed.
export const PanelActionItem = memo(function PanelActionItem({
  ev,
  action,
  onLoadDetails,
}: {
  ev: StreamEvent;
  action: string;
  onLoadDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const links = useContext(SessionLinkContext);
  const { head, quote } = actionParts(ev.content);
  const failed = !!ev.toolResultIsError;
  const result = ev.toolResult ?? "";
  const pending = ev.toolResult == null && ev.resultLength == null;
  // A summary page cut the text or the answer: expanding fetches them.
  const partial =
    (ev.resultLength ?? 0) > result.length || (ev.bodyLength ?? 0) > (ev.content ?? "").length;
  const session = /\b(ws-[\w-]+)/.exec(failed ? head : `${head} ${result}`)?.[1];
  const project = /\b(proj-[\w-]+)/.exec(head)?.[1];
  // The name as it is now; else as the answer quotes it ('Sent to
  // "modules".'); else a new session's title ("title in folder").
  const cut = head.lastIndexOf(" in ");
  const target =
    links.nameOf?.(session ?? project ?? "") ??
    ((!failed && /"([^"]+)"/.exec(result)?.[1]) ||
      (action === "start_session" && cut > 0 ? head.slice(0, cut) : head));
  const preview = bannerFirstLine(quote);
  return (
    <div
      className={`banner banner-action${open ? "" : " banner-folded"}${failed ? " banner-failed" : ""}${pending ? " banner-pending" : ""}`}
      data-action={action}
    >
      <span className="banner-icon">{failed ? "!" : "◆"}</span>
      <div className="banner-text">
        <span className="banner-label">{ACTION_LABEL[action] ?? action}</span>
        {target &&
          (session && links.open ? (
            <button
              className="action-target"
              title="Open that session"
              onClick={() => links.open!(session)}
            >
              {target}
            </button>
          ) : (
            <span className="action-target">{target}</span>
          ))}
        {failed ? (
          <span className="action-error">{bannerFirstLine(result)}</span>
        ) : (
          !open && preview && <span className="banner-first-line">{preview}</span>
        )}
        {open && (
          <>
            {quote && <MdBlock>{quote}</MdBlock>}
            {result && <div className="action-result">{result}</div>}
          </>
        )}
      </div>
      {(quote || result || partial) && (
        <button
          className="btn-inline banner-toggle"
          onClick={() => {
            if (partial) onLoadDetails?.();
            setOpen((v) => !v);
          }}
        >
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
});

// Tools that schedule the session's own future (ScheduleWakeup, cron) get a
// distinct chip so a "sleeping until X" step reads differently from work.
const SCHEDULE_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "CronDelete"]);

function chipClassFor(toolName: string | null, kind: string): string {
  if (toolName && SCHEDULE_TOOLS.has(toolName)) return "chip-schedule";
  if (toolName?.startsWith("mcp__panel__")) return "chip-panel";
  return kind === "tool_use" ? "chip-tool" : `chip-${kind}`;
}

// MCP tools arrive as mcp__<server>__<tool>; the panel's own read as plain
// names.
export function chipLabelFor(toolName: string): string {
  if (toolName === "ScheduleWakeup") return "⏰ Wake-up";
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return mcp[1] === "panel" ? mcp[2] : `${mcp[1]} · ${mcp[2]}`;
  return toolName;
}

// Effort, fast mode and context occupancy line under an agent message
// header. Thinking time and tokens show on the blocks in the steps.
export function MessageStatus({ msg }: { msg: Message }) {
  if (!msg.effort && !msg.fast && !msg.context) return null;
  const ctx = msg.context;
  const pct =
    ctx && ctx.window > 0 ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  const tone = pct == null ? "" : pct >= 90 ? " ctx-high" : pct >= 70 ? " ctx-warn" : "";
  return (
    <div className="message-status">
      {msg.effort && (
        <span className="status-chip" title="Reasoning effort">
          effort {msg.effort}
        </span>
      )}
      {msg.fast && (
        <span className="status-chip fast-chip" title="Fast mode">
          ⚡ fast
        </span>
      )}
      {ctx && pct != null && (
        <span
          className={`status-chip ctx-chip${tone}`}
          title={`Context: ${ctx.tokens.toLocaleString()} / ${ctx.window.toLocaleString()} tokens`}
        >
          <span className="ctx-bar">
            <span className="ctx-bar-fill" style={{ width: `${pct}%` }} />
          </span>
          ctx {formatTokens(ctx.tokens)} / {formatTokens(ctx.window)} · {pct}%
        </span>
      )}
    </div>
  );
}

function thinkingLabel(ev: StreamEvent): string {
  const head = ev.durationMs != null ? `Thought for ${formatDuration(ev.durationMs)}` : "Thinking";
  if (!ev.tokens) return head;
  const tokens = ev.tokens < 1000 ? String(ev.tokens) : `${(ev.tokens / 1000).toFixed(1)}k`;
  return `${head} · ${tokens} tokens`;
}

const KIND_LABEL: Record<string, string> = {
  thinking: "Thinking",
  tool_result: "Result",
  text: "Text",
  error: "Error",
};

// A tool body under its row: the row already shows the first line.
function afterFirstLine(content: string): string {
  const nl = content.indexOf("\n");
  return nl < 0 ? content : content.slice(nl + 1);
}

function resultLabel(len: number): string {
  return len > 1000 ? `${Math.round(len / 1000)}k chars` : `${len} chars`;
}

function formatSize(len: number): string {
  return len > 1000 ? `${(len / 1000).toFixed(len < 10000 ? 1 : 0)}k chars` : `${len} chars`;
}

export const EventItem = memo(function EventItem({
  ev,
  onLoadDetails,
}: {
  ev: StreamEvent;
  // Set while the message is a summary: called on first expand so the
  // bodies get fetched.
  onLoadDetails?: () => void;
}) {
  const [resultOpen, setResultOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const summarized = !!onLoadDetails;

  if (ev.kind === "compact" || ev.kind === "notice" || ev.kind === "retry" || ev.kind === "error") {
    return <BannerItem ev={ev} onLoadDetails={onLoadDetails} />;
  }

  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const toolName = isToolUse ? toolNameOf(ev) : null;
  const summary = isToolUse ? toolSummary(ev) : "";
  const label = toolName
    ? chipLabelFor(toolName)
    : ev.kind === "thinking"
      ? thinkingLabel(ev)
      : (KIND_LABEL[ev.kind] ?? ev.kind);
  const chipClass = chipClassFor(toolName, ev.kind);
  // Multi-line tool calls (Bash commands, edits) always show their body;
  // single-line ones (Read, Grep) get a summary and an optional details toggle.
  const bodyLen = ev.bodyLength ?? ev.content.length;
  const multiLine = isToolUse && (ev.content.includes("\n") || bodyLen > ev.content.length);
  const showBodyByDefault = isToolUse && (multiLine || !summary);
  const hasHiddenBody = isToolUse && !showBodyByDefault && bodyLen > summary.length + 16;
  const resultLen = isResult
    ? (ev.contentLength ?? ev.content.length)
    : (ev.resultLength ?? ev.toolResult?.length ?? 0);
  const hasResult = isToolUse && (ev.toolResult != null || ev.resultLength != null);
  // A summarised body renders as a placeholder until the details arrive.
  const bodyMissing = summarized && !isToolUse && !ev.content && (ev.contentLength ?? 0) > 0;
  const toolBodyMissing =
    summarized && isToolUse && showBodyByDefault && bodyLen > ev.content.length;
  const toggleResult = () => {
    if (summarized) onLoadDetails?.();
    setResultOpen((v) => !v);
  };
  const toggleBody = () => {
    if (summarized) onLoadDetails?.();
    setBodyOpen((v) => !v);
  };

  return (
    <div className={`event event-${ev.kind}`}>
      <div className="event-row">
        <span className={`event-chip ${chipClass}`}>{label}</span>
        {isToolUse && summary && (
          <span className="event-summary" title={summary}>
            {summary}
          </span>
        )}
        {isToolUse && ev.durationMs != null && (
          <span className="event-time" title="From the call to its result">
            {formatRunTime(ev.durationMs)}
          </span>
        )}
        {hasHiddenBody && (
          <button className="btn-inline" onClick={toggleBody}>
            {bodyOpen ? "Hide" : "Details"}
          </button>
        )}
        {(isResult || hasResult) && (
          <button className="btn-inline btn-diff" onClick={toggleResult}>
            {resultOpen ? "Hide result" : "Result"} · {resultLabel(resultLen)}
          </button>
        )}
      </div>
      {(bodyMissing || (toolBodyMissing && !bodyOpen)) && (
        <div
          className="event-content event-placeholder"
          onClick={isResult ? toggleResult : toggleBody}
        >
          {formatSize(bodyMissing ? (ev.contentLength ?? 0) : bodyLen)} · tap to load
        </div>
      )}
      {isResult ? (
        resultOpen &&
        ev.content && (
          <div className="event-content event-result">
            {ev.isMarkdown ? (
              <MdBlock>{ev.content}</MdBlock>
            ) : (
              <pre>
                <code>{ev.content}</code>
              </pre>
            )}
          </div>
        )
      ) : (
        <>
          {!bodyMissing && !toolBodyMissing && (!isToolUse || showBodyByDefault || bodyOpen) && (
            <div className="event-content">
              <MdBlock>{summary ? afterFirstLine(ev.content) : ev.content}</MdBlock>
            </div>
          )}
          {hasResult && resultOpen && ev.toolResult != null && (
            <div className="event-content event-result">
              {ev.toolResultIsMarkdown ? (
                <MdBlock>{ev.toolResult}</MdBlock>
              ) : (
                <pre>
                  <code>{ev.toolResult}</code>
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

export const SubAgentItem = memo(function SubAgentItem({
  ev,
  onLoadEvents,
  onCancel,
  onLoadDetails,
}: {
  ev: StreamEvent;
  onLoadEvents?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onLoadDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sa = ev.subagent;
  // The server holds more of the transcript than the client (a summary
  // page, or a live tail that arrived after the summary).
  const needsLoad = !!sa && (sa.eventCount ?? 0) > (sa.events?.length ?? 0);
  useEffect(() => {
    if (open && needsLoad && onLoadEvents && sa?.taskId) onLoadEvents(sa.taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per open/needsLoad flip; sa and onLoadEvents change identity on every stream update
  }, [open, needsLoad]);
  if (!sa) return null;

  const isDone =
    ev.kind === "subagent_done" ||
    sa.status === "completed" ||
    sa.status === "failed" ||
    sa.status === "stopped";
  const isRunning = !isDone;
  const label = sa.agentType || "Agent";
  const statusIcon = isRunning
    ? "↻"
    : sa.status === "completed"
      ? "✓"
      : sa.status === "stopped"
        ? "◼"
        : "✗";
  const statusCls = isRunning ? "running" : (sa.status ?? "failed");

  const allInner = sa.events ?? [];
  // Subagents can spawn subagents of their own; fold their nested lifecycle
  // events into one entry each and render them as nested SubAgentItems.
  const { regular: innerEvents, subagents: nestedAgents } = splitEvents(allInner);
  const totalCount = allInner.length || sa.eventCount || 0;
  const thinkingEvts = innerEvents.filter((e) => e.kind === "thinking");
  const toolEvts = innerEvents.filter((e) => e.kind === "tool_use");
  const textEvts = innerEvents.filter((e) => e.kind === "text");

  const handleToggle = () => {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && onLoadDetails) onLoadDetails();
  };

  const usageStr = sa.usage
    ? `${Math.round(sa.usage.totalTokens / 1000)}k tokens · ${sa.usage.toolUses} tools · ${(sa.usage.durationMs / 1000).toFixed(1)}s`
    : null;

  const headerParts: string[] = [];
  if (sa.description) headerParts.push(sa.description);
  if (!sa.description && isRunning && sa.lastTool) headerParts.push(`using ${sa.lastTool}`);

  return (
    <div className={`subagent-item subagent-${statusCls}`}>
      <div className="subagent-header" onClick={handleToggle}>
        <span className="events-toggle">{open ? "▾" : "▸"}</span>
        <span className={`subagent-status-icon subagent-icon-${statusCls}`}>{statusIcon}</span>
        <span className="subagent-label">{label}</span>
        {headerParts.length > 0 && <span className="subagent-desc">{headerParts.join(" · ")}</span>}
        {totalCount > 0 && (
          <span className="subagent-counts">
            {allInner.length > 0
              ? [
                  thinkingEvts.length > 0 ? `${thinkingEvts.length} thinking` : null,
                  toolEvts.length > 0 ? `${toolEvts.length} tool(s)` : null,
                  textEvts.length > 0 ? `${textEvts.length} text` : null,
                  nestedAgents.length > 0 ? `${nestedAgents.length} subagent(s)` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `${totalCount} event(s)`}
          </span>
        )}
        {sa.durationMs != null && (
          <span className="subagent-time" title="How long it ran">
            {formatRunTime(sa.durationMs)}
          </span>
        )}
        {isRunning && <span className="streaming-dot" />}
        {isRunning && onCancel && (
          <button
            className="btn-cancel-subagent"
            title="Cancel this subagent"
            onClick={(e) => {
              e.stopPropagation();
              onCancel(sa.taskId);
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {open && (
        <div className="subagent-details">
          {sa.prompt && (
            <div className="subagent-prompt">
              <MdBlock>{sa.prompt}</MdBlock>
            </div>
          )}
          {(needsLoad || (!sa.prompt && sa.hasPrompt) || (!sa.summary && sa.summaryLength)) && (
            <div className="subagent-loading">Loading…</div>
          )}
          {allInner.length > 0 && (
            <div className="subagent-events">
              {timelineBlocks(allInner).map((block, bi) => {
                if (block.kind === "steps") {
                  return block.events.map((ie, i) => (
                    <EventItem key={`${bi}-${i}`} ev={ie} onLoadDetails={onLoadDetails} />
                  ));
                }
                if (block.kind === "banner")
                  return <BannerItem key={`b${bi}`} ev={block.ev} onLoadDetails={onLoadDetails} />;
                if (block.kind === "action") {
                  return (
                    <PanelActionItem
                      key={`a${bi}`}
                      ev={block.ev}
                      action={block.action}
                      onLoadDetails={onLoadDetails}
                    />
                  );
                }
                return (
                  <SubAgentItem
                    key={block.ev.subagent!.taskId}
                    ev={block.ev}
                    onLoadEvents={onLoadEvents}
                    onCancel={onCancel}
                    onLoadDetails={onLoadDetails}
                  />
                );
              })}
            </div>
          )}
          {sa.summary && (
            <div className="subagent-summary">
              <MdBlock>{sa.summary}</MdBlock>
            </div>
          )}
          {usageStr && <div className="subagent-usage">{usageStr}</div>}
        </div>
      )}
    </div>
  );
});

function stepSummary(regular: StreamEvent[]): string {
  const count = (kind: string) => regular.filter((e) => e.kind === kind).length;
  const thinkingCount = count("thinking");
  const toolCount = count("tool_use");
  const errorCount = count("error");
  const resultCount = count("tool_result");
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  if (resultCount > 0) parts.push(`${resultCount} result${resultCount === 1 ? "" : "s"}`);
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  const other = regular.length - thinkingCount - toolCount - resultCount - errorCount;
  if (other > 0) parts.push(`${other} other`);
  if (parts.length === 0) parts.push(`${regular.length} event${regular.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Tool names in order of first use, for the collapsed step header.
function stepTools(regular: StreamEvent[]): string[] {
  const seen: string[] = [];
  for (const e of regular) {
    if (e.kind !== "tool_use") continue;
    const n = toolNameOf(e);
    if (n && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

export interface LiveBlock {
  text: string;
  since: number;
}

// Seconds since `since`, ticking while `active`.
function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since == null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

// One collapsible box for a run of ordinary events (thinking, tool calls).
// A thinking block streaming in is its last item: the box opens for it and
// folds again once it is done, unless the reader toggled it.
function StepBox({
  events,
  live,
  onLoadDetails,
  defaultOpen = false,
}: {
  events: StreamEvent[];
  live?: LiveBlock;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (defaultOpen || !!live);
  const secs = useElapsed(live?.since);
  const toggle = () => {
    if (!open) onLoadDetails?.();
    setToggled(!open);
  };
  const tools = stepTools(events);
  // Alone in its box, the thinking block's time heads the box: its own row
  // under a header with nothing else in it would leave an empty line.
  const alone = events.length === 0;
  return (
    <div className={`step-group${open ? " open" : ""}`}>
      <div className="step-header" onClick={toggle}>
        <span className="events-toggle">{open ? "▾" : "▸"}</span>
        {live && (alone || !open) && <LiveChip secs={secs} />}
        {events.length > 0 && <span className="step-summary">{stepSummary(events)}</span>}
        {!open && tools.length > 0 && (
          <span className="step-tools">
            {tools.slice(0, 6).map((t) => (
              <span key={t} className={`event-chip chip-mini ${chipClassFor(t, "tool_use")}`}>
                {chipLabelFor(t)}
              </span>
            ))}
            {tools.length > 6 && <span className="step-tools-more">+{tools.length - 6}</span>}
          </span>
        )}
      </div>
      {open && (
        <div className="events-list">
          {events.map((ev, i) => (
            <EventItem key={i} ev={ev} onLoadDetails={onLoadDetails} />
          ))}
          {live && <LiveThinking text={live.text} secs={secs} chip={!alone} />}
        </div>
      )}
    </div>
  );
}

// A segment's events in timeline order: each subagent card and banner is a
// boundary, so the step boxes between them count only what happened there.
export function StepGroup({
  group,
  onLoadEvents,
  onCancelSubagent,
  onLoadDetails,
  defaultOpen = false,
  live,
}: {
  group: { step: number; events: StreamEvent[] };
  onLoadEvents?: (taskId: string) => void;
  onCancelSubagent?: (taskId: string) => void;
  onLoadDetails?: () => void;
  defaultOpen?: boolean;
  // A thinking block streaming in after these events.
  live?: LiveBlock;
}) {
  const blocks = timelineBlocks(group.events);
  // Where the finished block will land: the trailing step box, or a new one
  // after a card or banner (same key, so the box keeps its state).
  const liveOwnBox = live && blocks[blocks.length - 1]?.kind !== "steps";
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "steps") {
          return (
            <StepBox
              key={`s${i}`}
              events={block.events}
              live={i === blocks.length - 1 ? live : undefined}
              onLoadDetails={onLoadDetails}
              defaultOpen={defaultOpen}
            />
          );
        }
        if (block.kind === "banner")
          return <BannerItem key={`b${i}`} ev={block.ev} onLoadDetails={onLoadDetails} />;
        if (block.kind === "action") {
          return (
            <PanelActionItem
              key={`a${i}`}
              ev={block.ev}
              action={block.action}
              onLoadDetails={onLoadDetails}
            />
          );
        }
        return (
          <SubAgentItem
            key={block.ev.subagent!.taskId}
            ev={block.ev}
            onLoadEvents={onLoadEvents}
            onCancel={onCancelSubagent}
            onLoadDetails={onLoadDetails}
          />
        );
      })}
      {liveOwnBox && <StepBox key={`s${blocks.length}`} events={[]} live={live} />}
    </>
  );
}

function LiveChip({ secs }: { secs: number }) {
  return (
    <span className="event-chip chip-thinking chip-live">
      <span className="streaming-dot" />
      Thinking · {secs}s
    </span>
  );
}

// A thinking block as it streams in, so a long think does not look like a
// stuck agent: it grows like the reply's text, drawn as the finished block
// will be, which then takes its place.
export function LiveThinking({
  text,
  secs,
  chip = true,
}: {
  text: string;
  secs: number;
  chip?: boolean;
}) {
  if (!chip && !text) return null;
  return (
    <div className="live-thinking event event-thinking">
      {chip && (
        <div className="event-row">
          <LiveChip secs={secs} />
        </div>
      )}
      {text && (
        <div className="event-content">
          <StreamingMdBlock>{text}</StreamingMdBlock>
        </div>
      )}
    </div>
  );
}

// A tool call still running or a subagent still working: the turn is not
// waiting on the model.
function workInFlight(events: StreamEvent[]): boolean {
  return events.some(
    (e) =>
      (e.kind === "tool_use" && e.toolResult == null && e.resultLength == null) ||
      (e.kind === "subagent_start" && e.subagent?.status === "running"),
  );
}

function progressOf(msg: Message): string {
  const events = msg.events ?? [];
  const results = events.filter((e) => e.toolResult != null).length;
  return `${msg.content.length}:${events.length}:${results}`;
}

const WAIT_SHOWN_AFTER_MS = 5000;

// Nothing has arrived for a while and nothing else explains it: the turn
// is waiting on the model. Shown with how long, so a request that stalls
// is told apart from one that is thinking or running a tool.
function WaitingIndicator({
  progress,
  immediate = false,
}: {
  progress: string;
  immediate?: boolean;
}) {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
    setNow(Date.now());
  }, [progress]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const waited = Math.max(0, now - since);
  if (!immediate && waited < WAIT_SHOWN_AFTER_MS) return null;
  return (
    <div className="working-indicator">Waiting for the model · {Math.floor(waited / 1000)}s</div>
  );
}

// One broken message (an old persisted event missing a field, an unexpected
// shape) must not blank the whole transcript.
export class MessageBoundary extends Component<
  { children: ReactNode; messageId: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(err: unknown): void {
    console.error("[render] message", this.props.messageId, err);
  }
  render(): ReactNode {
    if (this.state.failed) {
      return <div className="message-render-error">This message could not be rendered.</div>;
    }
    return this.props.children;
  }
}

// The server leads an agent's notices with its avatar ("avatars/Alice.jpg
// **Alice** joined the team"): an image, not text to show.
function systemAvatar(content: string): [string | null, string] {
  const m = /^(avatars\/[^\s]+\.(?:jpe?g|png|webp|gif)) (.*)$/is.exec(content);
  return m ? [m[1], m[2]] : [null, content];
}

export const MessageItem = memo(function MessageItem({
  msg,
  agents,
  compact,
  highlight,
  onQuote,
  onLoadSubagentEvents,
  onCancelSubagent,
  onCancelQueued,
  onLoadDetails,
  onOpenWorkspace,
}: {
  msg: Message;
  agents: AgentInfo[];
  compact?: boolean;
  highlight?: boolean;
  onOpenWorkspace?: (workspaceId: string) => void;
  onQuote?: (msg: Message) => void;
  onLoadSubagentEvents?: (messageId: string, taskId: string) => void;
  onCancelSubagent?: (agentId: string, taskId: string) => void;
  onCancelQueued?: (messageId: string) => void;
  onLoadDetails?: (messageId: string) => void;
}) {
  const handleLoadEvents = useCallback(
    (taskId: string) => onLoadSubagentEvents?.(msg.id, taskId),
    [msg.id, onLoadSubagentEvents],
  );
  // Only wired while the message is a summary; once details arrive the
  // prop becomes undefined and the items render their bodies directly.
  const summarized = msg.detail === "summary";
  const handleLoadDetails = useMemo(
    () => (summarized && onLoadDetails ? () => onLoadDetails(msg.id) : undefined),
    [summarized, onLoadDetails, msg.id],
  );
  const outerLinks = useContext(SessionLinkContext);
  const sessionLinks = useMemo(
    () => ({ ...outerLinks, ...(onOpenWorkspace && { open: onOpenWorkspace }) }),
    [outerLinks, onOpenWorkspace],
  );
  const agentId = msg.agentId;
  const handleCancelSubagent = useMemo(
    () =>
      onCancelSubagent && agentId
        ? (taskId: string) => onCancelSubagent(agentId, taskId)
        : undefined,
    [agentId, onCancelSubagent],
  );

  if (msg.kind === "system") {
    const [avatar, text] = systemAvatar(msg.content);
    return (
      <div className="system-message">
        {avatar && <img className="system-avatar" src={avatar} alt="" />}
        <MdBlock>{text}</MdBlock>
      </div>
    );
  }

  const isUser = msg.kind === "user";
  const from = isUser ? msg.from : undefined;
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;
  const streaming = msg.status === "streaming";
  const activity = streaming ? (agent?.activity ?? null) : null;
  const thinkingLive = streaming && msg.liveThinking != null;

  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) => e.kind !== "text" && e.kind !== "text_delta" && e.kind !== "thinking_delta",
  );

  // Interleaved segments, using contentOffset to split msg.content. One
  // layout whatever has arrived so far: switching shapes when the first text
  // lands would remount the step boxes and fold whatever the reader opened.
  type Segment = { text: string; events: StreamEvent[] };
  const segments: Segment[] = [];
  const body = msg.content ?? "";
  // A thinking block that starts now lands at the current end of the text:
  // with the last events if no text followed them.
  let joinsLastEvents = false;
  if (!isUser && detailEvents.length === 0 && body) {
    segments.push({ text: body, events: [] });
  } else if (!isUser && detailEvents.length > 0) {
    // Events without an offset (older logs, error events) belong after all
    // the text rather than nowhere; subagent lifecycle events always sit
    // with their subagent_start so a task never splits across segments.
    const startOffsets = new Map<string, number>();
    for (const e of detailEvents) {
      if (e.kind === "subagent_start" && e.subagent?.taskId && e.contentOffset != null) {
        startOffsets.set(e.subagent.taskId, e.contentOffset);
      }
    }
    // Older logs carry no offsets at all: those events all happened before
    // the answer, so they go first, not after it. Within newer logs an event
    // without one (errors, some notices) sits with the event before it.
    const anyOffset = detailEvents.some((e) => e.contentOffset != null);
    const resolved = new Map<StreamEvent, number>();
    let last = 0;
    for (const e of detailEvents) {
      const taskId = e.subagent?.taskId;
      const own = taskId && startOffsets.has(taskId) ? startOffsets.get(taskId)! : e.contentOffset;
      const off = !anyOffset ? 0 : (own ?? last);
      resolved.set(e, off);
      last = off;
    }
    const offsetOf = (e: StreamEvent): number => resolved.get(e) ?? 0;
    const uniqueOffsets = [...new Set(detailEvents.map(offsetOf))].sort((a, b) => a - b);

    if (uniqueOffsets.length > 0) {
      let prevOff = 0;
      for (const off of uniqueOffsets) {
        const text = body.substring(prevOff, off).trim();
        const evtsAtOff = detailEvents.filter((e) => offsetOf(e) === off);
        segments.push({ text, events: evtsAtOff });
        prevOff = off;
      }
      const trailing = body.substring(prevOff).trim();
      if (trailing || streaming) {
        segments.push({ text: trailing, events: [] });
      }
      joinsLastEvents = body.length === prevOff;
    }
  }

  let liveAt = -1;
  if (thinkingLive) {
    if (segments.length === 0) segments.push({ text: "", events: [] });
    liveAt = joinsLastEvents ? segments.length - 2 : segments.length - 1;
  }
  const liveBlock = thinkingLive
    ? { text: msg.liveThinking!, since: msg.liveThinkingSince! }
    : undefined;

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const quoteButton =
    !isUser && onQuote && segments.length > 0 ? (
      <button className="btn-quote" title="Quote this message" onClick={() => onQuote(msg)}>
        ↩
      </button>
    ) : null;

  return (
    <SessionLinkContext.Provider value={sessionLinks}>
      <div
        id={`msg-${msg.id}`}
        className={`message${isUser ? " message-user" : " message-agent"}${compact ? " message-compact" : ""}${highlight ? " message-highlight" : ""}${msg.status === "queued" ? " message-queued" : ""}${msg.status === "error" ? " message-error" : ""}`}
      >
        <div className="message-gutter">
          {compact ? null : from ? (
            <div className="avatar-user avatar-from">{ORIGIN_GLYPH[from.role]}</div>
          ) : isUser ? (
            <div className="avatar-user">
              <img
                src="avatars/ykiko.jpg"
                alt="You"
                style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
              />
            </div>
          ) : agent ? (
            <AgentAvatar agent={agent} size={32} />
          ) : (
            <div className="avatar-user">?</div>
          )}
        </div>
        <div className="message-body">
          {!compact && (
            <div className="message-header">
              {isUser ? (
                <>
                  {from ? (
                    <button
                      className="message-author from-author"
                      title="Open that session"
                      onClick={() => onOpenWorkspace?.(from.workspaceId)}
                    >
                      {originLabel(from)}
                    </button>
                  ) : (
                    <span className="message-author user-author">You</span>
                  )}
                  {msg.status === "queued" && (
                    <span className="queued-badge">
                      queued
                      {onCancelQueued && (
                        <button
                          className="queued-cancel"
                          title="Remove from queue"
                          onClick={() => onCancelQueued(msg.id)}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  )}
                </>
              ) : agent ? (
                <>
                  <span className="message-author" style={{ color: agent.color }}>
                    {agent.name}
                  </span>
                  <span className="message-model">{shortModel(msg.model ?? agent.model)}</span>
                </>
              ) : null}
              <span className="message-time">{time}</span>
              {streaming && <span className="streaming-dot" />}
              {activity && <span className="activity-label">{activity}</span>}
              {!streaming && quoteButton}
            </div>
          )}
          {compact && (
            <div className="compact-header">
              <span className="message-time">{time}</span>
              {streaming && <span className="streaming-dot" />}
              {activity && <span className="activity-label">{activity}</span>}
              {!streaming && quoteButton}
            </div>
          )}
          {!isUser && <MessageStatus msg={msg} />}

          {msg.forwardRef && (
            <div className="forward-ref">
              <span className="forward-ref-icon">↩</span>
              <span className="forward-ref-agent">
                <Avatar
                  avatar={msg.forwardRef.fromAvatar}
                  color={
                    agents.find((a) => a.name === msg.forwardRef!.fromAgent)?.color ?? "transparent"
                  }
                  name={msg.forwardRef.fromAgent}
                  size={16}
                />
                {msg.forwardRef.fromAgent}
              </span>
              <span className="forward-ref-preview">{msg.forwardRef.preview}</span>
            </div>
          )}

          {streaming &&
            !thinkingLive &&
            !msg.content &&
            detailEvents.length === 0 &&
            (activity ? (
              <div className="working-indicator">{activity}</div>
            ) : (
              <WaitingIndicator progress="start" immediate />
            ))}

          {msg.images && msg.images.length > 0 && (
            <div className="msg-images">
              {msg.images.map((img, i) => (
                <a key={i} href={img.url} target="_blank" rel="noopener noreferrer">
                  <img src={img.url} alt={img.name} />
                </a>
              ))}
            </div>
          )}

          {isUser
            ? msg.content && (
                <div className="message-content" onCopy={copySelectionAsMarkdown}>
                  {renderMentionContent(msg.content, agents)}
                </div>
              )
            : segments.length > 0 && (
                <div className="message-content" onCopy={copySelectionAsMarkdown}>
                  {segments.map((seg, si) => (
                    <div key={si}>
                      {seg.text &&
                        (streaming ? (
                          <StreamingMdBlock>{seg.text}</StreamingMdBlock>
                        ) : (
                          <MdBlock>{seg.text}</MdBlock>
                        ))}
                      {(seg.events.length > 0 || si === liveAt) && (
                        <StepGroup
                          group={{ step: si, events: seg.events }}
                          onLoadEvents={handleLoadEvents}
                          onCancelSubagent={handleCancelSubagent}
                          onLoadDetails={handleLoadDetails}
                          live={si === liveAt ? liveBlock : undefined}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
          {streaming &&
            !thinkingLive &&
            !activity &&
            (msg.content || detailEvents.length > 0) &&
            !workInFlight(detailEvents) && <WaitingIndicator progress={progressOf(msg)} />}
        </div>
      </div>
    </SessionLinkContext.Provider>
  );
});
