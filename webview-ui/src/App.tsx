import { useState, useRef, useEffect, useCallback } from "react";
import { useServer, Workspace, Message, AgentInfo, AgentPreset, ModelOption } from "./useServer";

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
              onClick={() => { setSelectedPreset(i); setCustomName(""); }}
            >
              <div className="agent-avatar" style={{ width: 36, height: 36, background: p.color, fontSize: 18 }}>
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
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>

        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => { onAdd(finalName, model, preset?.avatar ?? "🤖", preset?.color ?? "#888"); onClose(); }}
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

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && project) { onCreate(name.trim(), project); onClose(); }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="dialog-title">New Workspace</div>
        <label className="dialog-field">
          <span>Name</span>
          <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Workspace name..." />
        </label>
        <label className="dialog-field">
          <span>Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>Create</button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ msg, agents }: { msg: Message; agents: AgentInfo[] }) {
  const isUser = msg.agentId === null;
  const agent = !isUser ? agents.find((a) => a.id === msg.agentId) : null;

  const events = msg.events ?? [];
  const thinkingEvents = events.filter((e) => e.kind === "thinking");
  const toolEvents = events.filter((e) => e.kind === "tool_use" || e.kind === "tool_result");

  return (
    <div className={`message ${isUser ? "user" : "agent"}`}>
      {!isUser && agent && (
        <div className="message-header">
          <AgentAvatar agent={agent} size={22} />
          <span className="message-agent-name">{agent.name}</span>
          <span className="message-model">{agent.model.replace("claude-", "").replace(/-/g, " ")}</span>
          {msg.status === "streaming" && <span className="streaming-dot" />}
        </div>
      )}
      {isUser && <div className="message-header"><span className="message-agent-name">You</span></div>}

      {msg.status === "streaming" && !msg.content && (
        <div className="working-indicator">Working...</div>
      )}

      {msg.content && <div className="message-content">{msg.content}</div>}

      {(thinkingEvents.length > 0 || toolEvents.length > 0) && (
        <details className="message-events">
          <summary>
            {toolEvents.length > 0 && `${toolEvents.length} tool call(s)`}
            {thinkingEvents.length > 0 && toolEvents.length > 0 && " · "}
            {thinkingEvents.length > 0 && `${thinkingEvents.length} thinking`}
          </summary>
          <div className="events-list">
            {events.filter((e) => e.kind !== "text").map((ev, i) => (
              <div key={i} className={`event event-${ev.kind}`}>
                <span className="event-kind">{ev.kind}</span>
                <pre>{ev.content}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function App() {
  const {
    workspaces, connected, presets, models, projects,
    createWorkspace, deleteWorkspace, addAgent, removeAgent, sendMessage, abort,
  } = useServer();

  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeWs = workspaces.find((w) => w.id === activeWsId);

  useEffect(() => {
    if (!activeWsId && workspaces.length > 0) setActiveWsId(workspaces[0].id);
  }, [workspaces, activeWsId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeWs?.messages]);

  const isAnyRunning = activeWs?.messages.some((m) => m.status === "streaming") ?? false;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !activeWs) return;
    sendMessage(activeWs.id, text);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "36px";
  }, [input, activeWs, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-header">
          <span>Workspaces {!connected && <span className="disconnected">(offline)</span>}</span>
          <button title="New workspace" onClick={() => setShowCreate(true)}>+</button>
        </div>
        <div className="task-list">
          {workspaces.map((ws) => {
            const running = ws.messages.some((m) => m.status === "streaming");
            return (
              <div
                key={ws.id}
                className={`task-item ${ws.id === activeWsId ? "active" : ""}`}
                onClick={() => setActiveWsId(ws.id)}
              >
                <div className={`task-status ${running ? "running" : "idle"}`} />
                <div className="task-info">
                  <div className="task-name">{ws.name}</div>
                  <div className="task-project">{ws.project}</div>
                </div>
                <button className="task-delete" title="Delete" onClick={(e) => {
                  e.stopPropagation();
                  deleteWorkspace(ws.id);
                  if (activeWsId === ws.id) setActiveWsId(null);
                }}>x</button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="main-panel">
        {activeWs ? (
          <>
            <div className="panel-header">
              <span className="panel-title">{activeWs.name} — {activeWs.project}</span>
              <div className="panel-agents">
                {activeWs.agents.map((agent) => (
                  <div key={agent.id} className="panel-agent" title={`${agent.name} (${agent.model})`}>
                    <AgentAvatar agent={agent} size={22} />
                    <span>{agent.name}</span>
                    <button className="agent-remove" onClick={() => removeAgent(activeWs.id, agent.id)}>x</button>
                  </div>
                ))}
                <button className="btn-add-agent" onClick={() => setShowAddAgent(true)}>+ Agent</button>
              </div>
            </div>

            <div className="messages">
              {activeWs.messages.length === 0 && activeWs.agents.length === 0 && (
                <div className="empty-state">
                  Add an agent to get started.
                </div>
              )}
              {activeWs.messages.length === 0 && activeWs.agents.length > 0 && (
                <div className="empty-state">
                  Send a message to start working.
                </div>
              )}
              {activeWs.messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} agents={activeWs.agents} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              <div className="input-row">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  placeholder={activeWs.agents.length > 1 ? "@name message, or send to default..." : "Send a message..."}
                  rows={1}
                  disabled={isAnyRunning || activeWs.agents.length === 0}
                />
                {isAnyRunning ? (
                  <button className="btn-abort" onClick={() => abort(activeWs.id)}>Stop</button>
                ) : (
                  <button onClick={handleSend} disabled={!input.trim() || activeWs.agents.length === 0}>Send</button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {workspaces.length === 0 ? "No workspaces yet. Click + to create one." : "Select a workspace."}
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
