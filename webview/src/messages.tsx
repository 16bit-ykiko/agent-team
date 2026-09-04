import { useState, useCallback, useMemo, memo } from "react";
import type { Message, AgentInfo, StreamEvent } from "./useServer";
import { splitEvents } from "./events";
import { toolNameOf, toolSummary } from "./stream";
import { copySelectionAsMarkdown } from "./clipboard";
import { MdBlock } from "./markdown";
import { AgentAvatar } from "./avatar";
import { shortModel, formatTokens } from "./format";

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

// Inline status line: compaction, CLI notices, API retries. Rendered as a
// sibling of the step box so it is visible without expanding anything.
export const BannerItem = memo(function BannerItem({ ev }: { ev: StreamEvent }) {
  const level =
    ev.kind === "compact" ? "compact" : ev.kind === "retry" ? "retry" : (ev.level ?? "notice");
  const icon =
    ev.kind === "compact"
      ? "⇢"
      : ev.kind === "retry"
        ? "↻"
        : level === "wakeup"
          ? "⏰"
          : level === "warning" || level === "error"
            ? "!"
            : "i";
  return (
    <div className={`banner banner-${level}`} data-kind={ev.kind}>
      <span className="banner-icon">{icon}</span>
      <div className="banner-text">
        {level === "wakeup" && <span className="banner-label">Woke up</span>}
        {ev.kind === "notice" ? <MdBlock>{ev.content}</MdBlock> : ev.content}
      </div>
    </div>
  );
});

// Tools that schedule the session's own future (ScheduleWakeup, cron) get a
// distinct chip so a "sleeping until X" step reads differently from work.
const SCHEDULE_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "CronDelete"]);

function chipClassFor(toolName: string | null, kind: string): string {
  if (toolName && SCHEDULE_TOOLS.has(toolName)) return "chip-schedule";
  return kind === "tool_use" ? "chip-tool" : `chip-${kind}`;
}

function chipLabelFor(toolName: string): string {
  return toolName === "ScheduleWakeup" ? "⏰ Wake-up" : toolName;
}

// Effort + context occupancy line under an agent message header.
export function MessageStatus({ msg }: { msg: Message }) {
  if (!msg.effort && !msg.context) return null;
  const ctx = msg.context;
  const pct = ctx ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : null;
  const tone = pct == null ? "" : pct >= 90 ? " ctx-high" : pct >= 70 ? " ctx-warn" : "";
  return (
    <div className="message-status">
      {msg.effort && (
        <span className="status-chip" title="Reasoning effort">
          effort {msg.effort}
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

const KIND_LABEL: Record<string, string> = {
  thinking: "Thinking",
  tool_result: "Result",
  text: "Text",
  error: "Error",
};

function resultLabel(len: number): string {
  return len > 1000 ? `${Math.round(len / 1000)}k chars` : `${len} chars`;
}

export const EventItem = memo(function EventItem({ ev }: { ev: StreamEvent }) {
  const [resultOpen, setResultOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);

  if (ev.kind === "compact" || ev.kind === "notice" || ev.kind === "retry") {
    return <BannerItem ev={ev} />;
  }

  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const hasResult = isToolUse && ev.toolResult != null;
  const toolName = isToolUse ? toolNameOf(ev) : null;
  const summary = isToolUse ? toolSummary(ev) : "";
  const label = toolName ? chipLabelFor(toolName) : (KIND_LABEL[ev.kind] ?? ev.kind);
  const chipClass = chipClassFor(toolName, ev.kind);
  // Multi-line tool calls (Bash commands, edits) always show their body;
  // single-line ones (Read, Grep) get a summary and an optional details toggle.
  const multiLine = isToolUse && ev.content.includes("\n");
  const showBodyByDefault = isToolUse && (multiLine || !summary);
  const hasHiddenBody = isToolUse && !showBodyByDefault && ev.content.length > summary.length + 16;
  const resultLen = isResult ? ev.content.length : (ev.toolResult?.length ?? 0);

  return (
    <div className={`event event-${ev.kind}`}>
      <div className="event-row">
        <span className={`event-chip ${chipClass}`}>{label}</span>
        {isToolUse && summary && (
          <span className="event-summary" title={summary}>
            {summary}
          </span>
        )}
        {hasHiddenBody && (
          <button className="btn-inline" onClick={() => setBodyOpen((v) => !v)}>
            {bodyOpen ? "Hide" : "Details"}
          </button>
        )}
        {(isResult || hasResult) && (
          <button className="btn-inline btn-diff" onClick={() => setResultOpen((v) => !v)}>
            {resultOpen ? "Hide result" : "Result"} · {resultLabel(resultLen)}
          </button>
        )}
      </div>
      {isResult ? (
        resultOpen && (
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
          {(!isToolUse || showBodyByDefault || bodyOpen) && (
            <div className="event-content">
              <MdBlock>{ev.content}</MdBlock>
            </div>
          )}
          {hasResult && resultOpen && (
            <div className="event-content event-result">
              {ev.toolResultIsMarkdown ? (
                <MdBlock>{ev.toolResult!}</MdBlock>
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
}: {
  ev: StreamEvent;
  onLoadEvents?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sa = ev.subagent;
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
  const { regular: innerEvents, subagents: nestedAgents, banners } = splitEvents(allInner);
  const needsLoad = allInner.length === 0 && (sa.eventCount ?? 0) > 0;
  const totalCount = allInner.length || sa.eventCount || 0;
  const thinkingEvts = innerEvents.filter((e) => e.kind === "thinking");
  const toolEvts = innerEvents.filter((e) => e.kind === "tool_use");
  const textEvts = innerEvents.filter((e) => e.kind === "text");

  const handleToggle = () => {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && needsLoad && onLoadEvents && sa.taskId) {
      onLoadEvents(sa.taskId);
    }
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
          {needsLoad && <div className="subagent-loading">Loading events...</div>}
          {(innerEvents.length > 0 || banners.length > 0) && (
            <div className="subagent-events">
              {allInner
                .filter((e) => !e.subagent)
                .map((ie, i) => (
                  <EventItem key={i} ev={ie} />
                ))}
            </div>
          )}
          {nestedAgents.map((ne) => (
            <SubAgentItem
              key={ne.subagent!.taskId}
              ev={ne}
              onLoadEvents={onLoadEvents}
              onCancel={onCancel}
            />
          ))}
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
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
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

export function StepGroup({
  group,
  onLoadEvents,
  onCancelSubagent,
  defaultOpen = false,
}: {
  group: { step: number; events: StreamEvent[] };
  onLoadEvents?: (taskId: string) => void;
  onCancelSubagent?: (taskId: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { regular: regularEvents, subagents, banners } = splitEvents(group.events);
  const tools = stepTools(regularEvents);

  // Subagents and banners render as their own top-level blocks, siblings of
  // the collapsed step box — not nested inside it.
  return (
    <>
      {regularEvents.length > 0 && (
        <div className={`step-group${open ? " open" : ""}`}>
          <div className="step-header" onClick={() => setOpen((v) => !v)}>
            <span className="events-toggle">{open ? "▾" : "▸"}</span>
            <span className="step-summary">{stepSummary(regularEvents)}</span>
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
              {regularEvents.map((ev, i) => (
                <EventItem key={i} ev={ev} />
              ))}
            </div>
          )}
        </div>
      )}
      {banners.map((ev, i) => (
        <BannerItem key={`b${i}`} ev={ev} />
      ))}
      {subagents.map((ev) => (
        <SubAgentItem
          key={ev.subagent!.taskId}
          ev={ev}
          onLoadEvents={onLoadEvents}
          onCancel={onCancelSubagent}
        />
      ))}
    </>
  );
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
}: {
  msg: Message;
  agents: AgentInfo[];
  compact?: boolean;
  highlight?: boolean;
  onQuote?: (msg: Message) => void;
  onLoadSubagentEvents?: (messageId: string, taskId: string) => void;
  onCancelSubagent?: (agentId: string, taskId: string) => void;
  onCancelQueued?: (messageId: string) => void;
}) {
  const handleLoadEvents = useCallback(
    (taskId: string) => onLoadSubagentEvents?.(msg.id, taskId),
    [msg.id, onLoadSubagentEvents],
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
    return (
      <div className="system-message">
        <MdBlock>{msg.content}</MdBlock>
      </div>
    );
  }

  const isUser = msg.kind === "user";
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;
  const streaming = msg.status === "streaming";
  const activity = streaming ? (agent?.activity ?? null) : null;

  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) => e.kind !== "text" && e.kind !== "text_delta" && e.kind !== "thinking_delta",
  );
  const hasDetails = detailEvents.length > 0 || streaming;

  // Build interleaved segments using contentOffset to split msg.content
  type Segment = { text: string; events: StreamEvent[]; streaming?: boolean };
  const segments: Segment[] = [];
  if (detailEvents.length > 0 && msg.content) {
    // Events without an offset (older logs, error events) belong after all
    // the text rather than nowhere; subagent lifecycle events always sit
    // with their subagent_start so a task never splits across segments.
    const startOffsets = new Map<string, number>();
    for (const e of detailEvents) {
      if (e.kind === "subagent_start" && e.subagent?.taskId && e.contentOffset != null) {
        startOffsets.set(e.subagent.taskId, e.contentOffset);
      }
    }
    const offsetOf = (e: StreamEvent): number => {
      const taskId = e.subagent?.taskId;
      if (taskId && startOffsets.has(taskId)) return startOffsets.get(taskId)!;
      return e.contentOffset ?? msg.content.length;
    };
    const uniqueOffsets = [...new Set(detailEvents.map(offsetOf))].sort((a, b) => a - b);

    if (uniqueOffsets.length > 0) {
      let prevOff = 0;
      for (const off of uniqueOffsets) {
        const text = msg.content.substring(prevOff, off).trim();
        const evtsAtOff = detailEvents.filter((e) => offsetOf(e) === off);
        segments.push({ text, events: evtsAtOff });
        prevOff = off;
      }
      const trailing = msg.content.substring(prevOff).trim();
      if (trailing || streaming) {
        segments.push({ text: trailing, events: [], streaming });
      }
    }
  }
  const isInterleaved = segments.length > 1 || (segments.length === 1 && segments[0].text !== "");

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const quoteButton =
    !isUser && onQuote ? (
      <button className="btn-quote" title="Quote this message" onClick={() => onQuote(msg)}>
        ↩
      </button>
    ) : null;

  return (
    <div
      id={`msg-${msg.id}`}
      className={`message${isUser ? " message-user" : " message-agent"}${compact ? " message-compact" : ""}${highlight ? " message-highlight" : ""}${msg.status === "queued" ? " message-queued" : ""}${msg.status === "error" ? " message-error" : ""}`}
    >
      <div className="message-gutter">
        {compact ? null : isUser ? (
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
                <span className="message-author user-author">You</span>
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
                <span className="message-model">{shortModel(agent.model)}</span>
              </>
            ) : null}
            <span className="message-time">{time}</span>
            {streaming && <span className="streaming-dot" />}
            {activity && <span className="activity-label">{activity}</span>}
          </div>
        )}
        {compact && (
          <div className="compact-header">
            <span className="message-time">{time}</span>
            {streaming && <span className="streaming-dot" />}
            {activity && <span className="activity-label">{activity}</span>}
          </div>
        )}
        {!isUser && <MessageStatus msg={msg} />}

        {msg.forwardRef && (
          <div className="forward-ref">
            <span className="forward-ref-icon">↩</span>
            <span className="forward-ref-agent">
              {msg.forwardRef.fromAvatar} {msg.forwardRef.fromAgent}
            </span>
            <span className="forward-ref-preview">{msg.forwardRef.preview}</span>
          </div>
        )}

        {streaming && !msg.content && detailEvents.length === 0 && (
          <div className="working-indicator">{activity ?? "Working..."}</div>
        )}

        {msg.images && msg.images.length > 0 && (
          <div className="msg-images">
            {msg.images.map((img, i) => (
              <a key={i} href={img.url} target="_blank" rel="noopener noreferrer">
                <img src={img.url} alt={img.name} />
              </a>
            ))}
          </div>
        )}

        {isInterleaved ? (
          <div className="message-content" onCopy={copySelectionAsMarkdown}>
            {quoteButton}
            {segments.map((seg, si) => (
              <div key={si}>
                {seg.text && <MdBlock>{seg.text}</MdBlock>}
                {seg.events.length > 0 && (
                  <StepGroup
                    group={{ step: si, events: seg.events }}
                    onLoadEvents={handleLoadEvents}
                    onCancelSubagent={handleCancelSubagent}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            {hasDetails &&
              (() => {
                const { regular: regEvts, subagents: saList, banners } = splitEvents(detailEvents);
                return (
                  <>
                    {(regEvts.length > 0 || streaming) && (
                      <StepGroup
                        group={{ step: 0, events: regEvts }}
                        onLoadEvents={handleLoadEvents}
                        onCancelSubagent={handleCancelSubagent}
                      />
                    )}
                    {banners.map((ev, i) => (
                      <BannerItem key={`b${i}`} ev={ev} />
                    ))}
                    {saList.map((ev) => (
                      <SubAgentItem
                        key={ev.subagent!.taskId}
                        ev={ev}
                        onLoadEvents={handleLoadEvents}
                        onCancel={handleCancelSubagent}
                      />
                    ))}
                  </>
                );
              })()}

            {msg.content && (
              <div className="message-content" onCopy={copySelectionAsMarkdown}>
                {msg.status === "done" && quoteButton}
                {isUser ? (
                  renderMentionContent(msg.content, agents)
                ) : (
                  <MdBlock>{msg.content}</MdBlock>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
