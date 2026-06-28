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
  HostConfig,
} from "./useServer";

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

function AgentAvatar({ agent, size = 28 }: { agent: AgentInfo; size?: number }) {
  return (
    <div
      className="agent-avatar"
      style={{ width: size, height: size, background: agent.color, fontSize: size * 0.5 }}
      title={`${agent.name} (${agent.model})`}
    >
      {agent.avatar}
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
                style={{ width: 36, height: 36, background: p.color, fontSize: 18 }}
              >
                {p.avatar}
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
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </optgroup>
                  )}
                  {codex.length > 0 && (
                    <optgroup label="Codex">
                      {codex.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
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

function CreateWorkspaceDialog({
  projects,
  hostConfigs,
  hosts,
  onClose,
  onCreate,
}: {
  projects: Record<string, Record<string, string>>;
  hostConfigs: Record<string, HostConfig>;
  hosts: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, project: string, hostId?: string, customPath?: string) => void;
}) {
  const projectNames = Object.keys(projects);
  const CUSTOM = "__custom__";
  const [name, setName] = useState("");
  const [project, setProject] = useState(projectNames[0] ?? "");
  const [customPath, setCustomPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isCustom = project === CUSTOM;

  const availableHosts = Object.entries(projects[project] ?? {})
    .filter(([hId]) => {
      const info = hosts.find((h) => h.id === hId);
      return info
        ? info.connected || hostConfigs[hId]?.type === "local"
        : hostConfigs[hId]?.type === "local";
    })
    .map(([hId]) => ({ id: hId, label: hostConfigs[hId]?.label ?? hId }));

  const [hostId, setHostId] = useState(availableHosts[0]?.id ?? "");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const hosts = Object.keys(projects[project] ?? {});
    if (hosts.length > 0 && !hosts.includes(hostId)) {
      setHostId(hosts[0]);
    }
  }, [project, hostId, projects]);

  const canSubmit = name.trim() && (isCustom ? customPath.trim() : project);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (isCustom) {
      const p = customPath.trim();
      const label = p.split("/").filter(Boolean).pop() || "custom";
      onCreate(name.trim(), label, hostId || undefined, p);
    } else {
      onCreate(name.trim(), project, hostId || undefined);
    }
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="dialog-title">New Workspace</div>
        <label className="dialog-field">
          <span>Name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name..."
          />
        </label>
        <label className="dialog-field">
          <span>Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projectNames.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value={CUSTOM}>Custom Path...</option>
          </select>
        </label>
        {isCustom && (
          <label className="dialog-field">
            <span>Path</span>
            <input
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/home/user/projects/..."
            />
          </label>
        )}
        {!isCustom && availableHosts.length > 1 && (
          <label className="dialog-field">
            <span>Host</span>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {availableHosts.map((h) => (
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
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={mdComponents}
      >
        {content}
      </Markdown>
    );
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
      {rest && (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={mdComponents}
        >
          {rest}
        </Markdown>
      )}
    </>
  );
}

function EventItem({
  ev,
  onOpenDiff,
}: {
  ev: StreamEvent;
  onOpenDiff?: (filePath: string, oldStr: string, newStr: string) => void;
}) {
  const [resultOpen, setResultOpen] = useState(false);
  const isResult = ev.kind === "tool_result";
  const isToolUse = ev.kind === "tool_use";
  const isCompact = ev.kind === "compact";
  const hasResult = isToolUse && ev.toolResult != null;

  if (isCompact) {
    return <div className="event event-compact"><span className="compact-text">{ev.content}</span></div>;
  }

  const resultLen = isResult ? ev.content.length : (ev.toolResult?.length ?? 0);
  const resultLabel = resultLen > 1000 ? `${Math.round(resultLen / 1000)}k chars` : `${resultLen} chars`;

  return (
    <div className={`event event-${ev.kind}`}>
      <span className="event-kind">
        {ev.kind}
        {ev.toolInput?.tool === "Edit" &&
          ev.toolInput.old_string != null &&
          onOpenDiff && (
            <button
              className="btn-diff"
              title="Open diff in VS Code"
              onClick={() =>
                onOpenDiff(
                  ev.toolInput!.file_path!,
                  ev.toolInput!.old_string!,
                  ev.toolInput!.new_string!,
                )
              }
            >
              Diff
            </button>
          )}
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
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {ev.content}
              </Markdown>
            ) : (
              <pre><code>{ev.content}</code></pre>
            )}
          </div>
        )
      ) : (
        <>
          <div className="event-content">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={mdComponents}
            >
              {ev.content}
            </Markdown>
          </div>
          {hasResult && resultOpen && (
            <div className="event-content">
              {ev.toolResultIsMarkdown ? (
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {ev.toolResult!}
                </Markdown>
              ) : (
                <pre><code>{ev.toolResult}</code></pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SubAgentItem({
  ev,
  onOpenDiff,
}: {
  ev: StreamEvent;
  onOpenDiff?: (filePath: string, oldStr: string, newStr: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sa = ev.subagent;
  if (!sa) return null;

  const isDone = ev.kind === "subagent_done" || sa.status === "completed" || sa.status === "failed" || sa.status === "stopped";
  const isRunning = !isDone;
  const label = sa.agentType || "Agent";
  const statusIcon = isRunning ? "↻" : sa.status === "completed" ? "✓" : "✗";
  const statusCls = isRunning ? "running" : sa.status === "completed" ? "completed" : "failed";

  const innerEvents = sa.events ?? [];
  const thinkingEvts = innerEvents.filter((e) => e.kind === "thinking");
  const toolEvts = innerEvents.filter((e) => e.kind === "tool_use");
  const textEvts = innerEvents.filter((e) => e.kind === "text");

  const usageStr = sa.usage
    ? `${Math.round(sa.usage.totalTokens / 1000)}k tokens · ${sa.usage.toolUses} tools · ${(sa.usage.durationMs / 1000).toFixed(1)}s`
    : null;

  const headerParts: string[] = [];
  if (sa.description) headerParts.push(sa.description);
  if (!sa.description && isRunning && sa.lastTool) headerParts.push(`using ${sa.lastTool}`);

  return (
    <div className={`subagent-item subagent-${statusCls}`}>
      <div className="subagent-header" onClick={() => setOpen((v) => !v)}>
        <span className="events-toggle">{open ? "▾" : "▸"}</span>
        <span className={`subagent-status-icon subagent-icon-${statusCls}`}>{statusIcon}</span>
        <span className="subagent-label">{label}</span>
        {headerParts.length > 0 && <span className="subagent-desc">{headerParts.join(" · ")}</span>}
        {innerEvents.length > 0 && (
          <span className="subagent-counts">
            {[
              thinkingEvts.length > 0 ? `${thinkingEvts.length} thinking` : null,
              toolEvts.length > 0 ? `${toolEvts.length} tool(s)` : null,
              textEvts.length > 0 ? `${textEvts.length} text` : null,
            ].filter(Boolean).join(" · ")}
          </span>
        )}
        {isRunning && <span className="streaming-dot" />}
      </div>
      {open && (
        <div className="subagent-details">
          {sa.prompt && (
            <div className="subagent-prompt">
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {sa.prompt}
              </Markdown>
            </div>
          )}
          {innerEvents.length > 0 && (
            <div className="subagent-events">
              {innerEvents.map((ie, i) => (
                <EventItem key={i} ev={ie} onOpenDiff={onOpenDiff} />
              ))}
            </div>
          )}
          {sa.summary && (
            <div className="subagent-summary">
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {sa.summary}
              </Markdown>
            </div>
          )}
          {usageStr && <div className="subagent-usage">{usageStr}</div>}
        </div>
      )}
    </div>
  );
}

function StepGroup({
  group,
  onOpenDiff,
}: {
  group: { step: number; events: StreamEvent[] };
  onOpenDiff?: (filePath: string, oldStr: string, newStr: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const regularEvents = group.events.filter(
    (e) => e.kind !== "subagent_start" && e.kind !== "subagent_progress" && e.kind !== "subagent_done",
  );

  const subagentMap = new Map<string, StreamEvent>();
  for (const e of group.events) {
    if (!e.subagent?.taskId) continue;
    if (e.kind !== "subagent_start" && e.kind !== "subagent_progress" && e.kind !== "subagent_done") continue;
    const existing = subagentMap.get(e.subagent.taskId);
    if (!existing || e.kind === "subagent_done" || (e.kind === "subagent_progress" && existing.kind === "subagent_start")) {
      const mergedEvents = existing?.subagent?.events ?? e.subagent.events;
      const merged = { ...e, subagent: { ...(existing?.subagent ?? {}), ...e.subagent, description: existing?.subagent?.description || e.subagent.description, events: mergedEvents } };
      subagentMap.set(e.subagent.taskId, merged);
    }
  }
  const subagents = [...subagentMap.values()];

  const thinkingCount = regularEvents.filter((e) => e.kind === "thinking").length;
  const toolCount = regularEvents.filter(
    (e) => e.kind === "tool_use",
  ).length;
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call(s)`);
  if (subagents.length > 0) parts.push(`${subagents.length} subagent(s)`);
  if (parts.length === 0) parts.push(`${group.events.length} event(s)`);

  return (
    <div className="step-group">
      <div className="step-header" onClick={() => setOpen((v) => !v)}>
        <span className="events-toggle">{open ? "▾" : "▸"}</span>
        <span className="step-summary">{parts.join(" · ")}</span>
      </div>
      {open && (
        <div className="events-list">
          {regularEvents.map((ev, i) => (
            <EventItem key={i} ev={ev} onOpenDiff={onOpenDiff} />
          ))}
        </div>
      )}
      {subagents.map((ev) => (
        <SubAgentItem key={ev.subagent!.taskId} ev={ev} onOpenDiff={onOpenDiff} />
      ))}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  msg,
  agents,
  compact,
  highlight,
  onOpenDiff,
  onQuote,
}: {
  msg: Message;
  agents: AgentInfo[];
  compact?: boolean;
  highlight?: boolean;
  onOpenDiff?: (filePath: string, oldString: string, newString: string) => void;
  onQuote?: (msg: Message) => void;
}) {
  const [eventsOpen, setEventsOpen] = useState(false);

  if (msg.kind === "system") {
    return (
      <div className="system-message">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={mdComponents}
        >
          {msg.content}
        </Markdown>
      </div>
    );
  }

  const isUser = msg.kind === "user";
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;

  const events = msg.events ?? [];
  const detailEvents = events.filter(
    (e) =>
      e.kind !== "text" &&
      e.kind !== "text_delta" &&
      e.kind !== "thinking_delta",
  );
  const hasDetails = detailEvents.length > 0 || msg.status === "streaming";

  // Build interleaved segments using contentOffset to split msg.content
  type Segment = { text: string; events: StreamEvent[]; streaming?: boolean };
  const segments: Segment[] = [];
  if (detailEvents.length > 0 && msg.content) {
    const offsets = detailEvents
      .map((e) => e.contentOffset)
      .filter((o): o is number => o != null);
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
          <div className="avatar-user">U</div>
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
                {seg.text && (
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={mdComponents}
                  >
                    {seg.text}
                  </Markdown>
                )}
                {seg.events.length > 0 && (
                  <StepGroup group={{ step: si, events: seg.events }} onOpenDiff={onOpenDiff} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            {hasDetails && (() => {
              const regEvts = detailEvents.filter(
                (e) => e.kind !== "subagent_start" && e.kind !== "subagent_progress" && e.kind !== "subagent_done",
              );
              const saMap = new Map<string, StreamEvent>();
              for (const e of detailEvents) {
                if (!e.subagent?.taskId) continue;
                if (e.kind !== "subagent_start" && e.kind !== "subagent_progress" && e.kind !== "subagent_done") continue;
                const ex = saMap.get(e.subagent.taskId);
                if (!ex || e.kind === "subagent_done" || (e.kind === "subagent_progress" && ex.kind === "subagent_start")) {
                  const mergedEvents = ex?.subagent?.events ?? e.subagent.events;
                  saMap.set(e.subagent.taskId, { ...e, subagent: { ...(ex?.subagent ?? {}), ...e.subagent, description: ex?.subagent?.description || e.subagent.description, events: mergedEvents } });
                }
              }
              const saList = [...saMap.values()];
              return (
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
                        if (saList.length > 0) parts.push(`${saList.length} subagent(s)`);
                        return parts.length > 0 ? parts.join(" · ") : "streaming...";
                      })()}
                    </span>
                  </div>
                  {eventsOpen && (
                    <div className="events-list">
                      {regEvts.map((ev, i) => (
                        <EventItem key={i} ev={ev} onOpenDiff={onOpenDiff} />
                      ))}
                    </div>
                  )}
                  {saList.map((ev) => (
                    <SubAgentItem key={ev.subagent!.taskId} ev={ev} onOpenDiff={onOpenDiff} />
                  ))}
                </div>
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
                  <button className="btn-quote" title="Quote this message" onClick={() => onQuote(msg)}>
                    ↩
                  </button>
                )}
                {isUser ? (
                  renderMentionContent(msg.content, agents)
                ) : (
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={mdComponents}
                  >
                    {msg.content}
                  </Markdown>
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
    projects,
    commands,
    hosts,
    hostConfigs,
    systemStatus,
    createWorkspace,
    deleteWorkspace,
    addAgent,
    removeAgent,
    sendMessage,
    abort,
    clearContext,
    openDiff,
    loadMessages,
  } = useServer();

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

  interface SearchResult {
    wsId: string;
    wsName: string;
    msg: Message;
    snippet: string;
  }

  const searchResults: SearchResult[] = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: SearchResult[] = [];
    for (const ws of workspaces) {
      for (const msg of ws.messages) {
        if (msg.kind === "system") continue;
        const text = msg.content.toLowerCase();
        const idx = text.indexOf(q);
        if (idx !== -1) {
          const start = Math.max(0, idx - 20);
          const end = Math.min(text.length, idx + q.length + 40);
          const snippet =
            (start > 0 ? "..." : "") +
            msg.content.slice(start, end) +
            (end < text.length ? "..." : "");
          results.push({ wsId: ws.id, wsName: ws.name, msg, snippet });
        }
        if (results.length >= 100) break;
      }
      if (results.length >= 100) break;
    }
    return results;
  }, [searchQuery, workspaces]);

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
  }, [activeWsId, sendMessage, pendingImages, uploading, quotedMsg]);

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
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div
        className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}
        style={{ width: sidebarWidth }}
      >
        <div className="sidebar-header">
          <span>Workspaces {!connected && <span className="disconnected">(offline)</span>}</span>
          <button title="New workspace" onClick={() => setShowCreate(true)}>
            +
          </button>
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
            {searchResults.length === 0 ? (
              <div className="search-empty">No results</div>
            ) : (
              searchResults.map((r, i) => (
                <div
                  key={i}
                  className="search-result-item"
                  onClick={() => jumpToMessage(r.wsId, r.msg.id)}
                >
                  <div className="search-result-ws">{r.wsName}</div>
                  <div className="search-result-snippet">{r.snippet}</div>
                  <div className="search-result-time">
                    {new Date(r.msg.timestamp).toLocaleString([], {
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
            {sortedWorkspaces.map((ws) => {
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
                      <span className="task-host">
                        {hostConfigs[ws.hostId]?.label ?? ws.hostId}
                      </span>
                    </div>
                    <div className="task-meta">
                      <span>{ws.project}</span>
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
                          onOpenDiff={openDiff}
                          onQuote={handleQuote}
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
                      {cmd.argumentHint && (
                        <span className="command-hint">{cmd.argumentHint}</span>
                      )}
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
                {isAnyRunning && (
                  <button className="btn-abort" onClick={() => abort(activeWs.id)}>
                    Stop
                  </button>
                )}
                <button
                  onClick={handleSend}
                  disabled={(!hasInput && pendingImages.length === 0) || !hasAgents || uploading}
                >
                  {uploading ? "Uploading..." : "Send"}
                </button>
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
          projects={projects}
          hostConfigs={hostConfigs}
          hosts={hosts}
          onClose={() => setShowCreate(false)}
          onCreate={createWorkspace}
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
