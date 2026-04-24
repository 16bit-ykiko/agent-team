import { useState, useRef, useEffect, useCallback, memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import {
  useServer,
  Workspace,
  Message,
  AgentInfo,
  AgentPreset,
  ModelOption,
  SystemStatus,
  SkillDef,
} from "./useServer";

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
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
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
  onClose,
  onCreate,
}: {
  projects: string[];
  onClose: () => void;
  onCreate: (name: string, project: string) => void;
}) {
  const [name, setName] = useState("");
  const [project, setProject] = useState(projects[0] ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && project) {
      onCreate(name.trim(), project);
      onClose();
    }
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
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>
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
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
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
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {rest}
        </Markdown>
      )}
    </>
  );
}

const MessageItem = memo(function MessageItem({
  msg,
  agents,
  compact,
  highlight,
  onOpenDiff,
}: {
  msg: Message;
  agents: AgentInfo[];
  compact?: boolean;
  highlight?: boolean;
  onOpenDiff?: (filePath: string, oldString: string, newString: string) => void;
}) {
  const [eventsOpen, setEventsOpen] = useState(false);

  if (msg.kind === "system") {
    return (
      <div className="system-message">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {msg.content}
        </Markdown>
      </div>
    );
  }

  const isUser = msg.kind === "user";
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;

  const events = msg.events ?? [];
  const detailEvents = events.filter((e) => e.kind !== "text");
  const thinkingCount = detailEvents.filter((e) => e.kind === "thinking").length;
  const toolCount = detailEvents.filter(
    (e) => e.kind === "tool_use" || e.kind === "tool_result",
  ).length;
  const errorCount = detailEvents.filter((e) => e.kind === "error").length;
  const hasDetails = detailEvents.length > 0 || msg.status === "streaming";

  const summaryParts: string[] = [];
  if (thinkingCount > 0) summaryParts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) summaryParts.push(`${toolCount} tool call(s)`);
  if (errorCount > 0) summaryParts.push(`${errorCount} error(s)`);
  if (msg.status === "streaming" && summaryParts.length === 0) summaryParts.push("streaming...");

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

        {hasDetails && (
          <div className="message-events">
            <div className="events-header" onClick={() => setEventsOpen((v) => !v)}>
              <span className="events-toggle">{eventsOpen ? "▾" : "▸"}</span>
              <span>{summaryParts.join(" · ")}</span>
            </div>
            {eventsOpen && (
              <div className="events-list">
                {detailEvents.map((ev, i) => (
                  <div key={i} className={`event event-${ev.kind}`}>
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
                    </span>
                    <div className="event-content">
                      {(ev.kind === "tool_use" || ev.kind === "thinking") && ev.content ? (
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {ev.content}
                        </Markdown>
                      ) : ev.kind === "tool_result" ? (
                        <pre>
                          <code>{ev.content}</code>
                        </pre>
                      ) : (
                        <pre>{ev.content}</pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {msg.status === "streaming" && !msg.content && detailEvents.length === 0 && (
          <div className="working-indicator">Working...</div>
        )}

        {msg.content && (
          <div className="message-content">
            {isUser ? (
              renderMentionContent(msg.content, agents)
            ) : (
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {msg.content}
              </Markdown>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

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

function SystemStatusPanel({ status }: { status: SystemStatus }) {
  const memPct = Math.round((status.memUsed / status.memTotal) * 100);

  return (
    <div className="system-status-panel">
      <div className="system-status-title">System</div>
      <div className="system-status-grid">
        <div className="status-item">
          <span className="status-label">OS</span>
          <span className="status-value" title={status.osName}>
            {status.osName}
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Host</span>
          <span className="status-value">{status.hostname}</span>
        </div>
        <div className="status-item">
          <span className="status-label">CPU</span>
          <span className="status-value">
            <span className="status-bar">
              <span
                className="status-bar-fill"
                style={{
                  width: `${status.cpuUsage}%`,
                  background:
                    status.cpuUsage > 80
                      ? "var(--error)"
                      : status.cpuUsage > 50
                        ? "var(--warning)"
                        : "var(--accent)",
                }}
              />
            </span>
            <span className="status-pct">{status.cpuUsage}%</span>
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Mem</span>
          <span className="status-value">
            <span className="status-bar">
              <span
                className="status-bar-fill"
                style={{
                  width: `${memPct}%`,
                  background:
                    memPct > 80 ? "var(--error)" : memPct > 50 ? "var(--warning)" : "var(--accent)",
                }}
              />
            </span>
            <span className="status-pct">
              {formatBytes(status.memUsed)} / {formatBytes(status.memTotal)}
            </span>
          </span>
        </div>
        <div className="status-item">
          <span className="status-label">Arch</span>
          <span className="status-value">{status.osArch}</span>
        </div>
        <div className="status-item">
          <span className="status-label">Uptime</span>
          <span className="status-value">{formatUptime(status.uptime)}</span>
        </div>
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
    skills,
    systemStatus,
    createWorkspace,
    deleteWorkspace,
    addAgent,
    removeAgent,
    sendMessage,
    abort,
    openDiff,
  } = useServer();

  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [cmdQuery, setCmdQuery] = useState<string | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [visibleCount, setVisibleCount] = useState(30);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draggingRef = useRef(false);

  const activeWs = workspaces.find((w) => w.id === activeWsId);

  interface SearchResult {
    wsId: string;
    wsName: string;
    msg: Message;
    snippet: string;
  }

  const searchResults: SearchResult[] = (() => {
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
  })();

  const jumpToMessage = useCallback(
    (wsId: string, msgId: string) => {
      const ws = workspaces.find((w) => w.id === wsId);
      if (ws) {
        const msgIdx = ws.messages.findIndex((m) => m.id === msgId);
        if (msgIdx >= 0) setVisibleCount(Math.max(30, ws.messages.length - msgIdx + 10));
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
    if (!activeWsId && workspaces.length > 0) setActiveWsId(workspaces[0].id);
  }, [workspaces, activeWsId]);

  useEffect(() => {
    setVisibleCount(30);
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView();
    });
  }, [activeWsId]);

  const onMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollTop < 80) {
      setVisibleCount((v) => v + 30);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeWs?.messages]);

  const isAnyRunning = activeWs?.messages.some((m) => m.status === "streaming") ?? false;
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

  const filteredCmds = skills.filter((c) => {
    if (cmdQuery === null) return false;
    if (cmdQuery === "") return true;
    return c.name.toLowerCase().startsWith(cmdQuery.toLowerCase());
  });

  const applyCommand = useCallback((cmdName: string) => {
    setInput(`/${cmdName} `);
    setCmdQuery(null);
    textareaRef.current?.focus();
  }, []);

  const applyMention = useCallback(
    (agentName: string) => {
      const atIdx = input.lastIndexOf("@");
      if (atIdx !== -1) {
        setInput(input.slice(0, atIdx) + `@${agentName} `);
      }
      setMentionQuery(null);
      textareaRef.current?.focus();
    },
    [input],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !activeWs) return;

    const cmdMatch = text.match(/^\/(\w+)\s*([\s\S]*)/);
    if (cmdMatch) {
      const skill = skills.find((c) => c.name === cmdMatch[1]);
      if (skill) {
        const args = cmdMatch[2].trim();
        let content = skill.template.replace(/\{args\}/g, args).trim();
        let target: string | undefined;

        if (skill.target === "reviewer") {
          target = activeWs.agents.find((a) => a.name.toLowerCase().includes("review"))?.name;
        } else if (skill.target === "first_arg") {
          const parts = args.match(/^(\S+)\s+([\s\S]+)/);
          if (parts) {
            const agent = activeWs.agents.find(
              (a) => a.name.toLowerCase() === parts[1].toLowerCase(),
            );
            if (agent) {
              target = agent.name;
              content = skill.template.replace(/\{args\}/g, parts[2]).trim();
            }
          }
        }

        sendMessage(activeWs.id, content, target);
        setInput("");
        setCmdQuery(null);
        setMentionQuery(null);
        if (textareaRef.current) textareaRef.current.style.height = "36px";
        return;
      }
    }

    sendMessage(activeWs.id, text);
    setInput("");
    setMentionQuery(null);
    setCmdQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = "36px";
  }, [input, activeWs, skills, sendMessage]);

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

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const el = e.target;
    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    const cursor = el.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIdx(0);
    } else {
      setMentionQuery(null);
    }

    const cmdMatch = val.match(/^\/(\w*)$/);
    if (cmdMatch) {
      setCmdQuery(cmdMatch[1]);
      setCmdIdx(0);
    } else {
      setCmdQuery(null);
    }
  };

  return (
    <div className="app">
      <div className="sidebar" style={{ width: sidebarWidth }}>
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
            {workspaces.map((ws) => {
              const streamingMsgs = ws.messages.filter((m) => m.status === "streaming");
              const activeAgentIds = new Set(streamingMsgs.map((m) => m.agentId).filter(Boolean));
              const activeAgents = ws.agents.filter((a) => activeAgentIds.has(a.id));
              const running = streamingMsgs.length > 0;
              return (
                <div
                  key={ws.id}
                  className={`task-item ${ws.id === activeWsId ? "active" : ""}${running ? " task-item-active" : ""}`}
                  onClick={() => setActiveWsId(ws.id)}
                >
                  <div className={`task-status ${running ? "running" : "idle"}`} />
                  <div className="task-info">
                    <div className="task-name">{ws.name}</div>
                    <div className="task-project">{ws.project}</div>
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
                <span className="panel-title">
                  {activeWs.name} — {activeWs.project}
                </span>
                <div className="panel-agents">
                  {activeWs.agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="panel-agent"
                      title={`${agent.name} (${agent.model})`}
                    >
                      <AgentAvatar agent={agent} size={22} />
                      <span>{agent.name}</span>
                      <button
                        className="agent-remove"
                        onClick={() => removeAgent(activeWs.id, agent.id)}
                      >
                        x
                      </button>
                    </div>
                  ))}
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
              </div>
            </div>

            <div className="messages" ref={messagesContainerRef} onScroll={onMessagesScroll}>
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
                const startIdx = Math.max(0, total - visibleCount);
                const visible = msgs.slice(startIdx);
                return (
                  <>
                    {startIdx > 0 && (
                      <div className="load-more-hint">{startIdx} earlier messages</div>
                    )}
                    {visible.map((msg, i) => {
                      const prev = i > 0 ? visible[i - 1] : null;
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
                        />
                      );
                    })}
                  </>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
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
                      <span className="command-icon">{cmd.icon}</span>
                      <span className="command-name">/{cmd.name}</span>
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
              <div className="input-row">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    activeWs.agents.length > 1
                      ? "Type / for commands, @ to mention an agent..."
                      : "Type / for commands, or send a message..."
                  }
                  rows={1}
                  disabled={!hasAgents}
                />
                {isAnyRunning && (
                  <button className="btn-abort" onClick={() => abort(activeWs.id)}>
                    Stop
                  </button>
                )}
                <button onClick={handleSend} disabled={!input.trim() || !hasAgents}>
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {workspaces.length === 0
              ? "No workspaces yet. Click + to create one."
              : "Select a workspace."}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateWorkspaceDialog
          projects={projects}
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
