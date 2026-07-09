import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  memo,
  type ComponentProps,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import TurndownService from "turndown";
import {
  useServer,
  Workspace,
  Message,
  AgentInfo,
  AgentPreset,
  ModelOption,
  SystemStatus,
  StreamEvent,
  CommandInfo,
  HostInfo,
} from "./useServer";
import { splitEvents } from "./events";
import { groupWorkspaces, isGroupExpanded } from "./groups";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
  replacement: (_content, node) => {
    const code = (node as HTMLElement).querySelector("code")!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ?? "";
    return `\n\`\`\`${lang}\n${code.textContent}\n\`\`\`\n`;
  },
});

function getSelectionHtml(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const frag = sel.getRangeAt(0).cloneContents();
  const div = document.createElement("div");
  div.appendChild(frag);
  return div.innerHTML;
}

function CodeBlock({ children, ...rest }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <pre {...rest} ref={preRef}>
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard.writeText(preRef.current?.querySelector("code")?.textContent ?? "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {children}
    </pre>
  );
}

function ScrollTable(props: ComponentProps<"table">) {
  return (
    <div className="table-scroll-wrapper">
      <table {...props} />
    </div>
  );
}

const mdComponents = { pre: CodeBlock, table: ScrollTable };
const mdRemarkPlugins = [remarkGfm];
const mdRehypePlugins = [rehypeHighlight];

// Markdown parsing + highlighting is the hottest path during streaming.
// Memoized so a re-render only re-parses blocks whose text actually changed
// (inline plugin arrays would defeat react-markdown's own memoization).
const MdBlock = memo(function MdBlock({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={mdRemarkPlugins}
      rehypePlugins={mdRehypePlugins}
      components={mdComponents}
    >
      {children}
    </Markdown>
  );
});

function isImageAvatar(avatar: string): boolean {
  return (
    avatar.includes("/") ||
    avatar.endsWith(".jpg") ||
    avatar.endsWith(".png") ||
    avatar.endsWith(".webp")
  );
}

function AgentAvatar({ agent, size = 28 }: { agent: AgentInfo; size?: number }) {
  const isImg = isImageAvatar(agent.avatar);
  return (
    <div
      className="agent-avatar"
      style={{
        width: size,
        height: size,
        background: isImg ? "transparent" : agent.color,
        fontSize: size * 0.5,
      }}
      title={`${agent.name} (${agent.model})`}
    >
      {isImg ? (
        <img
          src={agent.avatar}
          alt={agent.name}
          style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
        />
      ) : (
        agent.avatar
      )}
    </div>
  );
}

function AddAgentDialog({
  presets,
  models,
  onClose,
  onAdd,
}: {
  presets: AgentPreset[];
  models: ModelOption[];
  onClose: () => void;
  onAdd: (name: string, model: string, avatar: string, color: string) => void;
}) {
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [customName, setCustomName] = useState("");

  const preset = presets[selectedPreset];
  const finalName = customName || preset?.name || "Agent";

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Add Agent</div>

        <div className="preset-grid">
          {presets.map((p, i) => (
            <div
              key={p.name}
              className={`preset-item ${i === selectedPreset ? "selected" : ""}`}
              onClick={() => {
                setSelectedPreset(i);
                setCustomName("");
              }}
            >
              <div
                className="agent-avatar"
                style={{
                  width: 36,
                  height: 36,
                  background: isImageAvatar(p.avatar) ? "transparent" : p.color,
                  fontSize: 18,
                }}
              >
                {isImageAvatar(p.avatar) ? (
                  <img
                    src={p.avatar}
                    alt={p.name}
                    style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover" }}
                  />
                ) : (
                  p.avatar
                )}
              </div>
              <span>{p.name}</span>
            </div>
          ))}
        </div>

        <label className="dialog-field">
          <span>Name (or use preset)</span>
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={preset?.name}
          />
        </label>

        <label className="dialog-field">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(() => {
              const claude = models.filter((m) => m.backend === "claude");
              const codex = models.filter((m) => m.backend === "codex");
              return (
                <>
                  {claude.length > 0 && (
                    <optgroup label="Claude">
                      {claude.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {codex.length > 0 && (
                    <optgroup label="Codex">
                      {codex.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </>
              );
            })()}
          </select>
        </label>

        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onAdd(finalName, model, preset?.avatar ?? "🤖", preset?.color ?? "#888");
              onClose();
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// A workspace is just a name plus a directory. The path field completes
// directories live against the server (shell-style tab completion).
export function CreateWorkspaceDialog({
  hosts,
  onClose,
  onCreate,
  onListDirs,
  dirSuggestions,
}: {
  hosts: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, path: string, hostId?: string) => void;
  onListDirs: (prefix: string) => void;
  dirSuggestions: { prefix: string; dirs: string[] };
}) {
  const [name, setName] = useState("");
  const [dirPath, setDirPath] = useState("~/");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "local");
  const nameRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const requestDirs = (value: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onListDirs(value), 120);
  };

  // The server echoes the prefix, so stale replies for older input are ignored.
  const suggestions = dirSuggestions.prefix === dirPath ? dirSuggestions.dirs : [];

  const handlePathChange = (value: string) => {
    setDirPath(value);
    setSuggestOpen(true);
    setSuggestIdx(0);
    requestDirs(value);
  };

  const pickSuggestion = (dir: string) => {
    setDirPath(dir);
    setSuggestIdx(0);
    requestDirs(dir);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (!suggestOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      pickSuggestion(suggestions[suggestIdx]);
    } else if (e.key === "Escape") {
      setSuggestOpen(false);
    }
  };

  const canSubmit = dirPath.trim().length > 0;
  const defaultName = dirPath.split("/").filter(Boolean).pop() ?? "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onCreate(
      (name.trim() || defaultName || "workspace").trim(),
      dirPath.trim(),
      hostId || undefined,
    );
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="dialog-title">New Workspace</div>
        <label className="dialog-field">
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName || "Workspace name..."}
          />
        </label>
        <label className="dialog-field path-field">
          <span>Path</span>
          <input
            value={dirPath}
            onChange={(e) => handlePathChange(e.target.value)}
            onKeyDown={handlePathKeyDown}
            onFocus={() => {
              setSuggestOpen(true);
              requestDirs(dirPath);
            }}
            placeholder="~/workspace/..."
            autoComplete="off"
            spellCheck={false}
          />
          {suggestOpen && suggestions.length > 0 && (
            <div className="dir-suggest">
              {suggestions.map((dir, i) => (
                <div
                  key={dir}
                  className={`dir-suggest-item ${i === suggestIdx ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSuggestion(dir);
                  }}
                >
                  {dir}
                </div>
              ))}
            </div>
          )}
        </label>
        {hosts.length > 1 && (
          <label className="dialog-field">
            <span>Host</span>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

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

export const EventItem = memo(function EventItem({ ev }: { ev: StreamEvent }) {
  const [resultOpen, setResultOpen] = useState(false);
  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const isCompact = ev.kind === "compact";
  const hasResult = isToolUse && ev.toolResult != null;

  if (isCompact) {
    return (
      <div className="event event-compact">
        <span className="compact-text">{ev.content}</span>
      </div>
    );
  }

  const resultLen = isResult ? ev.content.length : (ev.toolResult?.length ?? 0);
  const resultLabel =
    resultLen > 1000 ? `${Math.round(resultLen / 1000)}k chars` : `${resultLen} chars`;

  return (
    <div className={`event event-${ev.kind}`}>
      <span className="event-kind">
        {ev.kind}
        {(isResult || hasResult) && (
          <button className="btn-diff" onClick={() => setResultOpen((v) => !v)}>
            {resultOpen ? "Hide" : "Result"} ({resultLabel})
          </button>
        )}
      </span>
      {isResult ? (
        resultOpen && (
          <div className="event-content">
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
          <div className="event-content">
            <MdBlock>{ev.content}</MdBlock>
          </div>
          {hasResult && resultOpen && (
            <div className="event-content">
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
  const { regular: innerEvents, subagents: nestedAgents } = splitEvents(allInner);
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
          {innerEvents.length > 0 && (
            <div className="subagent-events">
              {innerEvents.map((ie, i) => (
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

export function StepGroup({
  group,
  onLoadEvents,
  onCancelSubagent,
}: {
  group: { step: number; events: StreamEvent[] };
  onLoadEvents?: (taskId: string) => void;
  onCancelSubagent?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { regular: regularEvents, subagents } = splitEvents(group.events);

  const thinkingCount = regularEvents.filter((e) => e.kind === "thinking").length;
  const toolCount = regularEvents.filter((e) => e.kind === "tool_use").length;
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call(s)`);
  if (parts.length === 0 && subagents.length === 0) parts.push(`${group.events.length} event(s)`);

  // Subagents render as their own top-level blocks, siblings of the collapsed
  // step box — not nested inside it.
  return (
    <>
      {regularEvents.length > 0 && (
        <div className="step-group">
          <div className="step-header" onClick={() => setOpen((v) => !v)}>
            <span className="events-toggle">{open ? "▾" : "▸"}</span>
            <span className="step-summary">{parts.join(" · ")}</span>
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
}: {
  msg: Message;
  agents: AgentInfo[];
  compact?: boolean;
  highlight?: boolean;
  onQuote?: (msg: Message) => void;
  onLoadSubagentEvents?: (messageId: string, taskId: string) => void;
  onCancelSubagent?: (agentId: string, taskId: string) => void;
}) {
  const [eventsOpen, setEventsOpen] = useState(false);
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

  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) => e.kind !== "text" && e.kind !== "text_delta" && e.kind !== "thinking_delta",
  );
  const hasDetails = detailEvents.length > 0 || msg.status === "streaming";

  // Build interleaved segments using contentOffset to split msg.content
  type Segment = { text: string; events: StreamEvent[]; streaming?: boolean };
  const segments: Segment[] = [];
  if (detailEvents.length > 0 && msg.content) {
    const offsets = detailEvents.map((e) => e.contentOffset).filter((o): o is number => o != null);
    const uniqueOffsets = [...new Set(offsets)].sort((a, b) => a - b);

    if (uniqueOffsets.length > 0) {
      let prevOff = 0;
      for (const off of uniqueOffsets) {
        const text = msg.content.substring(prevOff, off).trim();
        const evtsAtOff = detailEvents.filter((e) => e.contentOffset === off);
        segments.push({ text, events: evtsAtOff });
        prevOff = off;
      }
      const trailing = msg.content.substring(prevOff).trim();
      if (trailing || msg.status === "streaming") {
        segments.push({ text: trailing, events: [], streaming: msg.status === "streaming" });
      }
    }
  }
  const isInterleaved = segments.length > 1 || (segments.length === 1 && segments[0].text !== "");

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      id={`msg-${msg.id}`}
      className={`message ${compact ? "message-compact" : ""}${highlight ? " message-highlight" : ""}`}
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
              <span className="message-author user-author">You</span>
            ) : agent ? (
              <>
                <span className="message-author" style={{ color: agent.color }}>
                  {agent.name}
                </span>
                <span className="message-model">
                  {agent.model.replace("claude-", "").replace(/-/g, " ")}
                </span>
              </>
            ) : null}
            <span className="message-time">{time}</span>
            {msg.status === "streaming" && <span className="streaming-dot" />}
          </div>
        )}
        {compact && msg.status === "streaming" && <span className="streaming-dot" />}

        {msg.forwardRef && (
          <div className="forward-ref">
            <span className="forward-ref-icon">↩</span>
            <span className="forward-ref-agent">
              {msg.forwardRef.fromAvatar} {msg.forwardRef.fromAgent}
            </span>
            <span className="forward-ref-preview">{msg.forwardRef.preview}</span>
          </div>
        )}

        {msg.status === "streaming" && !msg.content && detailEvents.length === 0 && (
          <div className="working-indicator">Working...</div>
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
          <div
            className="message-content"
            onCopy={(e) => {
              const html = getSelectionHtml();
              if (!html) return;
              e.preventDefault();
              const md = turndown.turndown(html);
              e.clipboardData.setData("text/plain", md);
            }}
          >
            {!isUser && onQuote && (
              <button className="btn-quote" title="Quote this message" onClick={() => onQuote(msg)}>
                ↩
              </button>
            )}
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
                const { regular: regEvts, subagents: saList } = splitEvents(detailEvents);
                return (
                  <>
                    {(regEvts.length > 0 || msg.status === "streaming") && (
                      <div className="message-events">
                        <div className="events-header" onClick={() => setEventsOpen((v) => !v)}>
                          <span className="events-toggle">{eventsOpen ? "▾" : "▸"}</span>
                          <span>
                            {(() => {
                              const parts: string[] = [];
                              const tc = regEvts.filter((e) => e.kind === "thinking").length;
                              const tl = regEvts.filter((e) => e.kind === "tool_use").length;
                              if (tc > 0) parts.push(`${tc} thinking`);
                              if (tl > 0) parts.push(`${tl} tool call(s)`);
                              return parts.length > 0 ? parts.join(" · ") : "streaming...";
                            })()}
                          </span>
                        </div>
                        {eventsOpen && (
                          <div className="events-list">
                            {regEvts.map((ev, i) => (
                              <EventItem key={i} ev={ev} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
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
              <div
                className="message-content"
                onCopy={(e) => {
                  const html = getSelectionHtml();
                  if (!html) return;
                  e.preventDefault();
                  const md = turndown.turndown(html);
                  e.clipboardData.setData("text/plain", md);
                }}
              >
                {!isUser && msg.content && msg.status === "done" && onQuote && (
                  <button
                    className="btn-quote"
                    title="Quote this message"
                    onClick={() => onQuote(msg)}
                  >
                    ↩
                  </button>
                )}
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

function compressToBlob(file: File, maxDim = 1600, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(src);
            blob ? resolve(blob) : reject(new Error("toBlob returned null"));
          },
          "image/jpeg",
          quality,
        );
      } catch (e) {
        URL.revokeObjectURL(src);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error(`Failed to load image: ${file.name}`));
    };
    img.src = src;
  });
}

async function uploadImage(file: File): Promise<{ name: string; url: string }> {
  let blob: Blob;
  try {
    blob = await Promise.race([
      compressToBlob(file),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Compression timeout")), 10000),
      ),
    ]);
  } catch {
    blob = file;
  }
  const contentType = blob instanceof File ? blob.type || "image/jpeg" : "image/jpeg";
  const res = await fetch("upload", {
    method: "POST",
    headers: { "Content-Type": contentType, "X-Filename": file.name },
    credentials: "include",
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatResetTime(resetsAt: number): string {
  const delta = resetsAt * 1000 - Date.now();
  if (delta <= 0) return "now";
  const mins = Math.floor(delta / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

function quotaBarColor(pct: number): string {
  if (pct >= 80) return "var(--error)";
  if (pct >= 50) return "var(--warning)";
  return "var(--accent)";
}

function StatusBar({ label, pct, extra }: { label: string; pct: number; extra?: string }) {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className="status-value">
        <span className="status-bar">
          <span
            className="status-bar-fill"
            style={{ width: `${pct}%`, background: quotaBarColor(pct) }}
          />
        </span>
        <span className="status-pct">{extra ?? `${pct}%`}</span>
      </span>
    </div>
  );
}

function SystemStatusPanel({ status }: { status: SystemStatus }) {
  const memPct = Math.round((status.memUsed / status.memTotal) * 100);

  return (
    <div className="system-status-panel">
      <div className="system-status-grid">
        <StatusBar label="CPU" pct={status.cpuUsage} />
        <StatusBar
          label="Mem"
          pct={memPct}
          extra={`${formatBytes(status.memUsed)} / ${formatBytes(status.memTotal)}`}
        />
        {status.quota.flatMap((q) => {
          const tag = status.quota.length > 1 ? q.label : "Opus";
          const items = [];
          if (q.fiveHour) {
            const pct = Math.round(q.fiveHour.utilization * 100);
            items.push(
              <StatusBar
                key={`${q.label}-5h`}
                label={`${tag} 5h`}
                pct={pct}
                extra={`${pct}% · ${formatResetTime(q.fiveHour.resetsAt)}`}
              />,
            );
          }
          if (q.sevenDay) {
            const pct = Math.round(q.sevenDay.utilization * 100);
            items.push(
              <StatusBar
                key={`${q.label}-7d`}
                label={`${tag} 7d`}
                pct={pct}
                extra={`${pct}% · ${formatResetTime(q.sevenDay.resetsAt)}`}
              />,
            );
          }
          return items;
        })}
      </div>
    </div>
  );
}

export function App() {
  const {
    workspaces,
    connected,
    presets,
    models,
    commands,
    hosts,
    systemStatus,
    createWorkspace,
    deleteWorkspace,
    addAgent,
    removeAgent,
    sendMessage,
    abort,
    clearContext,
    loadMessages,
    loadSubagentEvents,
    cancelSubagent,
    startReplayDemo,
    lastError,
    clearError,
    searchServer,
    searchResults,
    listDirs,
    dirSuggestions,
  } = useServer();

  // Server errors (busy agent, cancel failures...) were previously only
  // logged to the console; surface them as a dismissible toast.
  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(clearError, 6000);
    return () => clearTimeout(t);
  }, [lastError, clearError]);

  const [activeWsId, setActiveWsId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("activeWsId");
    } catch {
      return null;
    }
  });
  const [hasInput, setHasInput] = useState(false);
  const inputMapRef = useRef(new Map<string, string>());
  const prevWsIdRef = useRef<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [cmdQuery, setCmdQuery] = useState<string | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<Array<{ file: File; preview: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [quotedMsg, setQuotedMsg] = useState<{
    id: string;
    agentId: string | null;
    content: string;
  } | null>(null);

  const handleQuote = useCallback((msg: Message) => {
    setQuotedMsg({ id: msg.id, agentId: msg.agentId, content: msg.content });
  }, []);

  const [searchQuery, setSearchQuery] = useState("");
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const seenCountRef = useRef<Record<string, number>>({});
  const prevRunningRef = useRef<Record<string, boolean>>({});
  const [finishedStatus, setFinishedStatus] = useState<Record<string, "done" | "failed">>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draggingRef = useRef(false);

  const sortedWorkspaces = useMemo(
    () =>
      [...workspaces].sort((a, b) => {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        return bTime - aTime;
      }),
    [workspaces],
  );
  const activeWs = workspaces.find((w) => w.id === activeWsId);

  // Sidebar folder groups; explicit expand/collapse choices persist.
  const wsGroups = useMemo(() => groupWorkspaces(workspaces), [workspaces]);
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("wsGroupOverrides") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggleGroup = useCallback((key: string, expanded: boolean) => {
    setGroupOverrides((prev) => {
      const next = { ...prev, [key]: expanded };
      try {
        localStorage.setItem("wsGroupOverrides", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const activeWsRef = useRef(activeWs);
  activeWsRef.current = activeWs;

  useEffect(() => {
    for (const ws of workspaces) {
      if (!(ws.id in seenCountRef.current)) {
        seenCountRef.current[ws.id] = ws.messages.length;
      }
    }
  }, [workspaces]);

  useEffect(() => {
    if (activeWsId && activeWs) {
      seenCountRef.current[activeWsId] = activeWs.messages.length;
      setFinishedStatus((prev) => {
        if (!(activeWsId in prev)) return prev;
        const next = { ...prev };
        delete next[activeWsId];
        return next;
      });
    }
  }, [activeWsId, activeWs?.messages.length]);

  const runningSnapshot = useMemo(
    () =>
      Object.fromEntries(workspaces.map((ws) => [ws.id, ws.agents.some((a) => a.busy)] as const)),
    [workspaces],
  );

  useEffect(() => {
    const updates: Record<string, "done" | "failed"> = {};
    for (const ws of workspaces) {
      const isRunning = runningSnapshot[ws.id];
      const wasRunning = prevRunningRef.current[ws.id];
      if (wasRunning && !isRunning && ws.id !== activeWsId) {
        const lastAgent = [...ws.messages].reverse().find((m) => m.kind === "agent");
        updates[ws.id] = lastAgent?.status === "error" ? "failed" : "done";
      }
      prevRunningRef.current[ws.id] = isRunning;
    }
    if (Object.keys(updates).length > 0) {
      setFinishedStatus((prev) => ({ ...prev, ...updates }));
    }
  }, [runningSnapshot, activeWsId, workspaces]);

  // Search runs server-side over the full message history — the client only
  // holds lazily-loaded windows, so local filtering missed almost everything.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) return;
    const t = setTimeout(() => searchServer(q), 200);
    return () => clearTimeout(t);
  }, [searchQuery, searchServer]);
  // null = query in flight (debounce or awaiting the server echo).
  const searchHits = searchResults.query === searchQuery.trim() ? searchResults.hits : null;

  const jumpToMessage = useCallback(
    (wsId: string, msgId: string) => {
      const ws = workspaces.find((w) => w.id === wsId);
      if (ws && !ws.messagesLoaded) {
        loadMessages(ws.id);
      }
      setActiveWsId(wsId);
      setHighlightMsgId(msgId);
      setSearchQuery("");
      setTimeout(() => {
        document
          .getElementById(`msg-${msgId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => setHighlightMsgId(null), 2000);
      }, 100);
    },
    [workspaces],
  );

  useEffect(() => {
    if (activeWsId) {
      try {
        localStorage.setItem("activeWsId", activeWsId);
      } catch {}
    }
  }, [activeWsId]);

  useEffect(() => {
    if (!activeWsId && sortedWorkspaces.length > 0) setActiveWsId(sortedWorkspaces[0].id);
    if (activeWsId && workspaces.length > 0 && !workspaces.find((w) => w.id === activeWsId)) {
      setActiveWsId(sortedWorkspaces[0]?.id ?? null);
    }
  }, [sortedWorkspaces, activeWsId, workspaces]);

  useEffect(() => {
    if (prevWsIdRef.current && prevWsIdRef.current !== activeWsId) {
      inputMapRef.current.set(prevWsIdRef.current, textareaRef.current?.value ?? "");
    }
    prevWsIdRef.current = activeWsId;
    const restored = activeWsId ? (inputMapRef.current.get(activeWsId) ?? "") : "";
    const el = textareaRef.current;
    if (el) {
      el.value = restored;
      el.style.height = "36px";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
    setHasInput(restored.trim().length > 0);
    setMentionTarget(restored.match(/(?:^|\s)@(\S+)/)?.[1] ?? null);
    if (activeWsId && connected) loadMessages(activeWsId);
    userScrolledUpRef.current = false;
    prevMsgCountRef.current = 0;
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView();
    });
  }, [activeWsId, connected, loadMessages]);

  const loadingMoreRef = useRef(false);
  const onMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el || !activeWs || loadingMoreRef.current) return;
    if (el.scrollTop < 80 && activeWs.hasMore) {
      const oldest = activeWs.messages[0];
      if (oldest) {
        loadingMoreRef.current = true;
        loadMessages(activeWs.id, oldest.timestamp);
        setTimeout(() => {
          loadingMoreRef.current = false;
        }, 500);
      }
    }
  }, [activeWs, loadMessages]);

  const prevMsgCountRef = useRef(0);
  const userScrolledUpRef = useRef(false);

  const onMessagesScrollTrack = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 150;
    onMessagesScroll();
  }, [onMessagesScroll]);

  useEffect(() => {
    const msgs = activeWs?.messages ?? [];
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = msgs.length;
    if (prevCount === 0 && msgs.length > 0) {
      messagesEndRef.current?.scrollIntoView();
    } else if (msgs.length > prevCount && !userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeWs?.messages?.length]);

  const isAnyRunning = activeWs?.agents.some((a) => a.busy) ?? false;
  const hasAgents = (activeWs?.agents.length ?? 0) > 0;

  // The agent a Send would go to: first @mention in the draft, else the
  // default agent. The primary button morphs to Stop while it is busy.
  const [mentionTarget, setMentionTarget] = useState<string | null>(null);
  const targetAgent = useMemo(() => {
    if (!activeWs || activeWs.agents.length === 0) return null;
    if (mentionTarget) {
      const hit = activeWs.agents.find((a) => a.name === mentionTarget);
      if (hit) return hit;
    }
    return activeWs.agents.find((a) => a.isDefault) ?? activeWs.agents[0];
  }, [activeWs, mentionTarget]);
  const targetBusy = !!targetAgent?.busy;
  const othersRunning = activeWs?.agents.some((a) => a.busy && a.id !== targetAgent?.id) ?? false;

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const w = Math.max(150, Math.min(500, startW + ev.clientX - startX));
        setSidebarWidth(w);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const mentionAgents =
    activeWs?.agents.filter((a) => {
      if (mentionQuery === null) return false;
      if (mentionQuery === "") return true;
      return a.name.toLowerCase().startsWith(mentionQuery.toLowerCase());
    }) ?? [];

  const filteredCmds = commands.filter((c) => {
    if (cmdQuery === null) return false;
    if (cmdQuery === "") return true;
    return c.name.toLowerCase().startsWith(cmdQuery.toLowerCase());
  });

  const setDivText = useCallback(
    (text: string) => {
      if (activeWsId) inputMapRef.current.set(activeWsId, text);
      const el = textareaRef.current;
      if (el) {
        el.value = text;
        el.focus();
        el.selectionStart = el.selectionEnd = text.length;
        el.style.height = "36px";
        el.style.height = Math.min(el.scrollHeight, 120) + "px";
      }
      setHasInput(text.trim().length > 0);
    },
    [activeWsId],
  );

  const applyCommand = useCallback(
    (cmdName: string) => {
      setDivText(`/${cmdName} `);
      setCmdQuery(null);
      textareaRef.current?.focus();
    },
    [setDivText],
  );

  const applyMention = useCallback(
    (agentName: string) => {
      const val = textareaRef.current?.value ?? "";
      const atIdx = val.lastIndexOf("@");
      if (atIdx !== -1) {
        setDivText(val.slice(0, atIdx) + `@${agentName} `);
      }
      setMentionQuery(null);
      textareaRef.current?.focus();
    },
    [setDivText],
  );

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newImages = files
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ file, preview: URL.createObjectURL(file) }));
    setPendingImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }, []);

  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = (textareaRef.current?.value ?? "").trim();
    const ws = activeWsRef.current;
    if ((!text && pendingImages.length === 0) || !ws || uploading) return;
    // The target agent can't accept messages while running (the server would
    // reject with "Agent is busy"); the primary button shows Stop instead.
    if (targetBusy) return;

    let images: Array<{ name: string; url: string }> | undefined;
    if (pendingImages.length > 0) {
      setUploading(true);
      try {
        images = await Promise.all(pendingImages.map(({ file }) => uploadImage(file)));
      } catch (e) {
        console.error("Image upload failed:", e);
        alert(`Image upload failed: ${e instanceof Error ? e.message : e}`);
        setUploading(false);
        return;
      }
      setUploading(false);
      pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
      setPendingImages([]);
    }

    sendMessage(
      ws.id,
      text,
      undefined,
      images,
      quotedMsg
        ? { messageId: quotedMsg.id, agentId: quotedMsg.agentId, content: quotedMsg.content }
        : undefined,
    );
    if (activeWsId) inputMapRef.current.set(activeWsId, "");
    setMentionQuery(null);
    setCmdQuery(null);
    setQuotedMsg(null);
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "36px";
    }
    setHasInput(false);
  }, [activeWsId, sendMessage, pendingImages, uploading, quotedMsg, targetBusy]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (cmdQuery !== null && filteredCmds.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdIdx((i) => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdIdx((i) => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCommand(filteredCmds[cmdIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdQuery(null);
        return;
      }
    }
    if (mentionQuery !== null && mentionAgents.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionAgents.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionAgents.length) % mentionAgents.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionAgents[mentionIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const val = el.value;
    const has = val.trim().length > 0;
    if (has !== hasInput) setHasInput(has);
    if (activeWsId) inputMapRef.current.set(activeWsId, val);
    setMentionTarget(val.match(/(?:^|\s)@(\S+)/)?.[1] ?? null);

    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    const before = val.slice(0, el.selectionStart);

    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIdx(0);
    } else {
      setMentionQuery(null);
    }

    const cmdMatch = val.match(/^\/([\w-]*)$/);
    if (cmdMatch) {
      setCmdQuery(cmdMatch[1]);
      setCmdIdx(0);
    } else {
      setCmdQuery(null);
    }
  };

  return (
    <div className="app">
      {lastError && (
        <div className="error-toast" onClick={clearError} title="Dismiss">
          ⚠ {lastError}
        </div>
      )}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div
        className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}
        style={{ width: sidebarWidth }}
      >
        <div className="sidebar-header">
          <span>Workspaces {!connected && <span className="disconnected">(offline)</span>}</span>
          <span>
            <button
              title="Replay rendering demo (synthetic events for visual review)"
              onClick={() => {
                const wsId = startReplayDemo();
                setActiveWsId(wsId);
                setSidebarOpen(false);
              }}
            >
              🎬
            </button>
            <button title="New workspace" onClick={() => setShowCreate(true)}>
              +
            </button>
          </span>
        </div>
        <div className="search-bar">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            autoComplete="off"
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery("")}>
              x
            </button>
          )}
        </div>
        {searchQuery.trim() ? (
          <div className="search-results">
            {searchHits === null ? (
              <div className="search-empty">Searching...</div>
            ) : searchHits.length === 0 ? (
              <div className="search-empty">No results</div>
            ) : (
              searchHits.map((r, i) => (
                <div
                  key={i}
                  className="search-result-item"
                  onClick={() => jumpToMessage(r.workspaceId, r.messageId)}
                >
                  <div className="search-result-ws">{r.workspaceName}</div>
                  <div className="search-result-snippet">{r.snippet}</div>
                  <div className="search-result-time">
                    {new Date(r.timestamp).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="task-list">
            {wsGroups.map((g) => {
              const expanded =
                isGroupExpanded(g, groupOverrides, Date.now()) ||
                g.workspaces.some((w) => w.id === activeWsId);
              return (
                <div key={g.key} className="ws-group">
                  <div
                    className="ws-group-header"
                    title={g.key}
                    onClick={() => toggleGroup(g.key, !expanded)}
                  >
                    <span className="events-toggle">{expanded ? "▾" : "▸"}</span>
                    <span className="ws-group-label">{g.label}</span>
                    <span className="ws-group-count">{g.workspaces.length}</span>
                    {g.running && <span className="streaming-dot" />}
                  </div>
                  {expanded &&
                    g.workspaces.map((ws) => {
                      const activeAgents = ws.agents.filter((a) => a.busy);
                      const running = activeAgents.length > 0;
                      const unread = ws.messages.length - (seenCountRef.current[ws.id] ?? 0);
                      return (
                        <div
                          key={ws.id}
                          className={`task-item ${ws.id === activeWsId ? "active" : ""}${running ? " task-item-active" : ""}`}
                          onClick={() => {
                            setActiveWsId(ws.id);
                            setSidebarOpen(false);
                          }}
                        >
                          <div
                            className={`task-status ${running ? "running" : (finishedStatus[ws.id] ?? "idle")}`}
                          />
                          <div className="task-info">
                            <div className="task-name">
                              <span className="task-name-text">
                                {ws.name}
                                {unread > 0 && ws.id !== activeWsId && (
                                  <span className="unread-badge">{unread}</span>
                                )}
                              </span>
                              {ws.gitBranch && <span className="task-branch">{ws.gitBranch}</span>}
                            </div>
                            {activeAgents.length > 0 && (
                              <div className="task-active-agents">
                                {activeAgents.map((a) => (
                                  <span
                                    key={a.id}
                                    className="task-active-agent"
                                    style={{ background: a.color }}
                                  >
                                    {a.avatar} {a.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <button
                            className="task-delete"
                            title="Delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteWorkspace(ws.id);
                              if (activeWsId === ws.id) setActiveWsId(null);
                            }}
                          >
                            x
                          </button>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
        {systemStatus && <SystemStatusPanel status={systemStatus} />}
      </div>

      <div className="resize-handle" onMouseDown={onResizeStart} />

      <div className="main-panel">
        {activeWs ? (
          <>
            <div className="panel-header">
              <div className="panel-header-top">
                <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
                  &#9776;
                </button>
                <span className="panel-title">
                  {activeWs.name} — {activeWs.project}
                </span>
                <div className="panel-agents">
                  {activeWs.agents.map((agent) => {
                    const status = agent.busy ? "busy" : connected ? "online" : "offline";
                    return (
                      <div
                        key={agent.id}
                        className="panel-agent"
                        title={`${agent.name} (${agent.model})`}
                      >
                        <AgentAvatar agent={agent} size={22} />
                        <span className={`agent-status-dot agent-status-${status}`} />
                        <span>{agent.name}</span>
                        <span className={`agent-status-label agent-status-${status}`}>
                          {status === "busy" ? "working" : status}
                        </span>
                        <button
                          className="agent-clear"
                          title="Clear context"
                          onClick={() => clearContext(activeWs.id, agent.id)}
                        >
                          &#8635;
                        </button>
                        <button
                          className="agent-remove"
                          onClick={() => removeAgent(activeWs.id, agent.id)}
                        >
                          x
                        </button>
                      </div>
                    );
                  })}
                  <button className="btn-add-agent" onClick={() => setShowAddAgent(true)}>
                    + Agent
                  </button>
                </div>
              </div>
              <div className="workspace-info-bar">
                <span className="ws-info-item" title={activeWs.cwd}>
                  <span className="ws-info-icon">&#128193;</span>
                  {activeWs.cwd}
                </span>
                {activeWs.gitBranch && (
                  <span className="ws-info-item ws-info-branch">
                    <span className="ws-info-icon">&#9831;</span>
                    {activeWs.gitBranch}
                  </span>
                )}
                {activeWs.prUrl && (
                  <a className="pr-card" href={activeWs.prUrl} target="_blank" rel="noreferrer">
                    <span className="pr-icon">&#9741;</span>
                    <span className="pr-number">#{activeWs.prUrl.split("/").pop()}</span>
                    {activeWs.prTitle && <span className="pr-title">{activeWs.prTitle}</span>}
                  </a>
                )}
              </div>
            </div>

            <div className="messages" ref={messagesContainerRef} onScroll={onMessagesScrollTrack}>
              {(() => {
                const msgs = activeWs.messages;
                const total = msgs.length;
                if (total === 0) {
                  return (
                    <div className="empty-state">
                      {activeWs.agents.length === 0
                        ? "Add an agent to get started."
                        : "Send a message to start working."}
                    </div>
                  );
                }
                return (
                  <>
                    {activeWs.hasMore && (
                      <div className="load-more-hint">Scroll up to load more</div>
                    )}
                    {msgs.map((msg, i) => {
                      const prev = i > 0 ? msgs[i - 1] : null;
                      const compact =
                        !!prev &&
                        msg.kind === "agent" &&
                        prev.kind === "agent" &&
                        !!msg.turnId &&
                        msg.turnId === prev.turnId;
                      return (
                        <MessageItem
                          key={msg.id}
                          msg={msg}
                          agents={activeWs.agents}
                          compact={compact}
                          highlight={msg.id === highlightMsgId}
                          onQuote={handleQuote}
                          onLoadSubagentEvents={(messageId, taskId) =>
                            loadSubagentEvents(activeWs.id, messageId, taskId)
                          }
                          onCancelSubagent={(agentId, taskId) =>
                            cancelSubagent(activeWs.id, agentId, taskId)
                          }
                        />
                      );
                    })}
                  </>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              {quotedMsg &&
                (() => {
                  const qa = activeWs.agents.find((a) => a.id === quotedMsg.agentId);
                  return (
                    <div className="quote-bar">
                      <div className="quote-bar-content">
                        <span className="quote-bar-agent">
                          {qa?.avatar ?? "👤"} {qa?.name ?? "User"}
                        </span>
                        <span className="quote-bar-preview">
                          {quotedMsg.content.slice(0, 100)}
                          {quotedMsg.content.length > 100 ? "..." : ""}
                        </span>
                      </div>
                      <button className="quote-bar-close" onClick={() => setQuotedMsg(null)}>
                        ✕
                      </button>
                    </div>
                  );
                })()}
              {cmdQuery !== null && filteredCmds.length > 0 && (
                <div className="command-popup">
                  {filteredCmds.map((cmd, i) => (
                    <div
                      key={cmd.name}
                      className={`command-item ${i === cmdIdx ? "active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyCommand(cmd.name);
                      }}
                    >
                      <span className="command-name">/{cmd.name}</span>
                      {cmd.argumentHint && <span className="command-hint">{cmd.argumentHint}</span>}
                      <span className="command-desc">{cmd.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {mentionQuery !== null && mentionAgents.length > 0 && (
                <div className="mention-popup">
                  {mentionAgents.map((a, i) => (
                    <div
                      key={a.id}
                      className={`mention-item ${i === mentionIdx ? "active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyMention(a.name);
                      }}
                    >
                      <AgentAvatar agent={a} size={20} />
                      <span className="mention-name">{a.name}</span>
                      <span className="mention-model">
                        {a.model.replace("claude-", "").replace(/-/g, " ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="image-preview-strip">
                  {pendingImages.map((img, i) => (
                    <div key={i} className="image-preview-item">
                      <img src={img.preview} alt={img.file.name} />
                      <button
                        className="image-preview-remove"
                        onClick={() => removePendingImage(i)}
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="input-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={handleFileSelect}
                />
                <button
                  className="btn-attach"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!hasAgents}
                  title="Attach image"
                >
                  +
                </button>
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  disabled={!hasAgents}
                  placeholder={
                    activeWs.agents.length > 1
                      ? "Type / for commands, @ to mention an agent..."
                      : "Type / for commands, or send a message..."
                  }
                  rows={1}
                />
                {othersRunning && (
                  <button
                    className="btn-abort btn-abort-others"
                    title="Stop all running agents"
                    onClick={() => abort(activeWs.id)}
                  >
                    Stop all
                  </button>
                )}
                {targetBusy ? (
                  <button
                    className="btn-abort btn-primary-slot"
                    title={`Stop ${targetAgent!.name}`}
                    onClick={() => abort(activeWs.id, targetAgent!.id)}
                  >
                    ◼ Stop
                  </button>
                ) : (
                  <button
                    className="btn-primary-slot"
                    onClick={handleSend}
                    disabled={(!hasInput && pendingImages.length === 0) || !hasAgents || uploading}
                    title={
                      targetAgent && activeWs.agents.length > 1
                        ? `Send to ${targetAgent.name}`
                        : "Send"
                    }
                  >
                    {uploading ? "Uploading..." : "Send"}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="empty-header mobile-only">
              <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
                &#9776;
              </button>
              <span>Agent Team</span>
            </div>
            <div className="empty-state">
              {workspaces.length === 0
                ? "No workspaces yet. Click + to create one."
                : "Select a workspace."}
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <CreateWorkspaceDialog
          hosts={hosts}
          onClose={() => setShowCreate(false)}
          onCreate={createWorkspace}
          onListDirs={listDirs}
          dirSuggestions={dirSuggestions}
        />
      )}

      {showAddAgent && activeWs && (
        <AddAgentDialog
          presets={presets}
          models={models}
          onClose={() => setShowAddAgent(false)}
          onAdd={(name, model, avatar, color) => addAgent(activeWs.id, name, model, avatar, color)}
        />
      )}
    </div>
  );
}
