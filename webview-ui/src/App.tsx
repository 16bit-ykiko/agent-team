import { useState, useRef, useEffect, useCallback } from "react";
import { useServer, Task, Message, StreamEvent } from "./useServer";

function roleLabel(role: Message["role"]): string {
  return {
    user: "You",
    planner: "Planner",
    coder: "Coder",
    reviewer: "Reviewer",
    validator: "Validator",
    system: "System",
  }[role];
}

function CreateTaskDialog({
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
        <div className="dialog-title">New Task</div>
        <label className="dialog-field">
          <span>Name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Task name..."
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

export function App() {
  const { tasks, connected, projects, createTask, sendMessage, deleteTask } = useServer();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeTask = tasks.find((t) => t.id === activeTaskId);

  useEffect(() => {
    if (!activeTaskId && tasks.length > 0) {
      setActiveTaskId(tasks[0].id);
    }
  }, [tasks, activeTaskId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeTask?.messages.length]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !activeTask) return;

    sendMessage(activeTask.id, text);
    setInput("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "36px";
    }
  }, [input, activeTask, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const handleDeleteTask = (taskId: string) => {
    deleteTask(taskId);
    if (activeTaskId === taskId) {
      setActiveTaskId(null);
    }
  };

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-header">
          <span>Tasks {!connected && "(disconnected)"}</span>
          <button title="New task" onClick={() => setShowCreate(true)}>+</button>
        </div>
        <div className="task-list">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`task-item ${task.id === activeTaskId ? "active" : ""}`}
              onClick={() => setActiveTaskId(task.id)}
            >
              <div className={`task-status ${task.status}`} />
              <div className="task-info">
                <div className="task-name">{task.name}</div>
                <div className="task-project">{task.project}</div>
              </div>
              <button
                className="task-delete"
                title="Delete task"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTask(task.id);
                }}
              >
                x
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="main-panel">
        {activeTask ? (
          <>
            <div className="panel-header">
              <div className={`task-status ${activeTask.status}`} />
              <span>
                {activeTask.name} — {activeTask.project}
              </span>
            </div>

            <div className="messages">
              {activeTask.messages.length === 0 ? (
                <div className="empty-state">
                  No messages yet. Send a message to start this task.
                </div>
              ) : (
                activeTask.messages.map((msg) => (
                  <div key={msg.id} className={`message ${msg.role === "user" ? "user" : "agent"}`}>
                    <div className="message-role">{roleLabel(msg.role)}</div>
                    <div className="message-content">{msg.content}</div>
                    {msg.events && msg.events.length > 0 && (
                      <details className="message-events">
                        <summary>{msg.events.length} event(s)</summary>
                        {msg.events.map((ev, i) => (
                          <div key={i} className={`event event-${ev.kind}`}>
                            <span className="event-kind">{ev.kind}</span>
                            <pre>{ev.content}</pre>
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              <div className="input-row">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Send a message..."
                  rows={1}
                  disabled={activeTask.status === "running"}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || activeTask.status === "running"}
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {tasks.length === 0
              ? "No tasks yet. Click + to create one."
              : "Select a task to view details."}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateTaskDialog
          projects={projects}
          onClose={() => setShowCreate(false)}
          onCreate={createTask}
        />
      )}
    </div>
  );
}
