import { useState, useRef, useEffect } from "react";
import type { AgentPreset, ModelOption, HostInfo } from "./useServer";
import { isImageAvatar } from "./avatar";

// Small modal confirmation used for destructive actions (purging archived
// workspaces). Enter confirms, Escape cancels.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <p className="dialog-body">{body}</p>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddAgentDialog({
  presets,
  models,
  accounts,
  onClose,
  onAdd,
}: {
  presets: AgentPreset[];
  models: ModelOption[];
  accounts: string[];
  onClose: () => void;
  onAdd: (name: string, model: string, avatar: string, color: string, account?: string) => void;
}) {
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [customName, setCustomName] = useState("");
  const [account, setAccount] = useState("");

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

        {accounts.length > 0 && (
          <label className="dialog-field">
            <span>Account</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">local (default)</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onAdd(
                finalName,
                model,
                preset?.avatar ?? "🤖",
                preset?.color ?? "#888",
                account || undefined,
              );
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
  initialPath,
}: {
  hosts: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, path: string, hostId?: string) => void;
  onListDirs: (prefix: string) => void;
  dirSuggestions: { prefix: string; dirs: string[] };
  initialPath?: string;
}) {
  const [name, setName] = useState("");
  const [dirPath, setDirPath] = useState(initialPath ?? "~/");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "local");
  const nameRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    nameRef.current?.focus();
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(blurTimerRef.current);
    };
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
    if (e.nativeEvent.isComposing) return;
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
              clearTimeout(blurTimerRef.current);
              setSuggestOpen(true);
              requestDirs(dirPath);
            }}
            onBlur={() => {
              // Tapping/clicking anywhere else closes the list — the only way
              // to dismiss on mobile, where there is no Esc. Delayed so a
              // click that lands past the list (e.g. on Create after the
              // list shrinks) completes before the layout shifts. Picking a
              // suggestion never blurs: items preventDefault on mousedown.
              blurTimerRef.current = setTimeout(() => setSuggestOpen(false), 150);
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
