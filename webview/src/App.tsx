import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useServer, Message } from "./useServer";
import { groupWorkspaces } from "./groups";
import { hasRunningSubagents } from "./events";
import { extractImageFiles, installMacCtrlClipboard } from "./clipboard";
import { isImeKeyEvent } from "./ime";
import { AgentAvatar } from "./avatar";
import { formatRelative } from "./format";
import { MessageItem } from "./messages";
import { AddAgentDialog, CreateWorkspaceDialog, ConfirmDialog } from "./dialogs";
import { Sidebar } from "./Sidebar";

// Re-exported for tests and for anyone importing the old single-file layout.
export { EventItem, SubAgentItem, StepGroup, MessageItem, BannerItem } from "./messages";
export { AddAgentDialog, CreateWorkspaceDialog, ConfirmDialog } from "./dialogs";
export { Sidebar } from "./Sidebar";

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
    cancelQueued,
    accounts,
    defaultAccount,
    setDefaultAccount,
    startReplayDemo,
    lastError,
    clearError,
    searchServer,
    searchResults,
    listDirs,
    dirSuggestions,
    archiveWorkspace,
    unarchiveWorkspace,
    purgeArchived,
    archiveAfterDays,
  } = useServer();
  const [showPurge, setShowPurge] = useState(false);

  // Server errors (busy agent, cancel failures...) were previously only
  // logged to the console; surface them as a dismissible toast.
  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(clearError, 6000);
    return () => clearTimeout(t);
  }, [lastError, clearError]);

  // iOS Safari overlays the keyboard on top of a 100vh layout instead of
  // resizing it, hiding the input row and the newest messages. Track the
  // visual viewport and size the app to it; keep the bottom in view while
  // the composer is focused.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      // Pin the app to the keyboard-free visible strip: size it to the
      // visual viewport AND follow its pan offset. (Never call scrollTo here
      // — that fights the browser's own scroll-into-view and pushes the
      // composer back under the keyboard.)
      const el = document.documentElement;
      el.style.setProperty("--app-height", `${vv.height}px`);
      el.style.setProperty("--app-offset", `${vv.offsetTop}px`);
      if (document.activeElement === textareaRef.current && messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

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
  const [createInPath, setCreateInPath] = useState<string | undefined>(undefined);
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
  const composingRef = useRef(false);
  const compositionEndTsRef = useRef(0);

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

  useEffect(
    () =>
      installMacCtrlClipboard(
        () => textareaRef.current,
        (files) =>
          setPendingImages((prev) => [
            ...prev,
            ...files.map((file) => ({ file, preview: URL.createObjectURL(file) })),
          ]),
      ),
    [],
  );
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

  // Agents whose latest work still has subagents running: the session can be
  // idle while background subagents finish, and that should still read as
  // "working".
  const agentsAwaitingSubs = useMemo(() => {
    const set = new Set<string>();
    for (const m of activeWs?.messages ?? []) {
      if (m.agentId && hasRunningSubagents(m.events)) set.add(m.agentId);
    }
    return set;
  }, [activeWs?.messages]);

  // Sidebar folder groups; explicit expand/collapse choices persist.
  const wsGroups = useMemo(() => groupWorkspaces(workspaces), [workspaces]);
  const [seenTick, setSeenTick] = useState(0);
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

  // Switching into a workspace whose group was explicitly collapsed clears
  // that override once (e.g. jumping there from search), after which the
  // group can be collapsed again freely.
  useEffect(() => {
    if (!activeWsId) return;
    const g = wsGroups.find((grp) => grp.workspaces.some((w) => w.id === activeWsId));
    if (!g) return;
    setGroupOverrides((prev) => {
      if (prev[g.key] !== false) return prev;
      const next = { ...prev, [g.key]: true };
      try {
        localStorage.setItem("wsGroupOverrides", JSON.stringify(next));
      } catch {}
      return next;
    });
    // Deliberately keyed on the active workspace only: re-running on every
    // wsGroups identity change would instantly undo a manual collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWsId]);
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
      setSeenTick((t) => t + 1);
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
    if (isImeKeyEvent(e, composingRef.current, compositionEndTsRef.current)) return;
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
        <Sidebar
          workspaces={workspaces}
          activeWsId={activeWsId}
          connected={connected}
          groupOverrides={groupOverrides}
          seenCounts={seenTick >= 0 ? seenCountRef.current : {}}
          finishedStatus={finishedStatus}
          searchQuery={searchQuery}
          searchHits={searchHits}
          systemStatus={systemStatus}
          accounts={accounts}
          defaultAccount={defaultAccount}
          onSelect={(id) => {
            setActiveWsId(id);
            setSidebarOpen(false);
          }}
          onDelete={(id) => {
            deleteWorkspace(id);
            if (activeWsId === id) setActiveWsId(null);
          }}
          onToggleGroup={toggleGroup}
          onSearchChange={setSearchQuery}
          onJump={jumpToMessage}
          onCreate={() => {
            setCreateInPath(undefined);
            setShowCreate(true);
          }}
          onCreateIn={(cwd) => {
            setCreateInPath(cwd);
            setShowCreate(true);
          }}
          onReplayDemo={() => {
            const wsId = startReplayDemo();
            setActiveWsId(wsId);
            setSidebarOpen(false);
          }}
          onPurgeArchived={() => setShowPurge(true)}
          onSetDefaultAccount={setDefaultAccount}
        />
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
                    const working = agent.busy || agentsAwaitingSubs.has(agent.id);
                    const status = working ? "busy" : connected ? "online" : "offline";
                    const statusText = status === "busy" ? (agent.activity ?? "working") : status;
                    return (
                      <div
                        key={agent.id}
                        className={`panel-agent panel-agent-${status}`}
                        title={`${agent.name} (${agent.model}${agent.account ? `, account: ${agent.account}` : ""})`}
                      >
                        <AgentAvatar agent={agent} size={22} />
                        <span className={`agent-status-dot agent-status-${status}`} />
                        <span className="panel-agent-name">{agent.name}</span>
                        {agent.effort && (
                          <span className="agent-effort" title="Reasoning effort (/effort)">
                            {agent.effort}
                          </span>
                        )}
                        {agent.account && <span className="agent-account">@{agent.account}</span>}
                        <span className={`agent-status-label agent-status-${status}`}>
                          {statusText}
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
                <span className="ws-info-spacer" />
                {activeWs.archivedAt == null ? (
                  <button
                    className="btn-ghost ws-archive-btn"
                    title="Archive: unload history from memory and stop idle sessions"
                    disabled={isAnyRunning}
                    onClick={() => archiveWorkspace(activeWs.id)}
                  >
                    Archive
                  </button>
                ) : null}
              </div>
              {activeWs.archivedAt != null && (
                <div className="archived-banner">
                  <span>
                    Archived {formatRelative(activeWs.archivedAt)}
                    {archiveAfterDays > 0 ? ` · idle for over ${archiveAfterDays} days` : ""}.
                    Sending a message restores it.
                  </span>
                  <button className="btn-inline" onClick={() => unarchiveWorkspace(activeWs.id)}>
                    Restore
                  </button>
                </div>
              )}
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
                          onCancelQueued={(messageId) => cancelQueued(activeWs.id, messageId)}
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
                  name="chat-message"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={(e) => {
                    composingRef.current = false;
                    compositionEndTsRef.current = e.timeStamp;
                  }}
                  onPaste={(e) => {
                    const imgs = extractImageFiles(e.clipboardData);
                    if (imgs.length === 0) return;
                    e.preventDefault();
                    setPendingImages((prev) => [
                      ...prev,
                      ...imgs.map((file) => ({ file, preview: URL.createObjectURL(file) })),
                    ]);
                  }}
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
                {targetBusy && (
                  <button
                    className="btn-abort"
                    title={`Stop ${targetAgent!.name}`}
                    onClick={() => abort(activeWs.id, targetAgent!.id)}
                  >
                    ◼
                  </button>
                )}
                <button
                  className="btn-primary-slot"
                  onClick={handleSend}
                  disabled={(!hasInput && pendingImages.length === 0) || !hasAgents || uploading}
                  title={
                    targetBusy
                      ? `${targetAgent!.name} is busy — message will run next`
                      : targetAgent && activeWs.agents.length > 1
                        ? `Send to ${targetAgent.name}`
                        : "Send"
                  }
                >
                  {uploading ? "Uploading..." : targetBusy ? "Queue" : "Send"}
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
          hosts={hosts}
          onClose={() => setShowCreate(false)}
          onCreate={createWorkspace}
          onListDirs={listDirs}
          dirSuggestions={dirSuggestions}
          initialPath={createInPath}
        />
      )}

      {showPurge && (
        <ConfirmDialog
          title="Delete archived workspaces"
          body={`Permanently delete ${workspaces.filter((w) => w.archivedAt != null).length} archived workspace(s), including their message history and logs.`}
          confirmLabel="Delete all"
          danger
          onConfirm={purgeArchived}
          onClose={() => setShowPurge(false)}
        />
      )}

      {showAddAgent && activeWs && (
        <AddAgentDialog
          presets={presets}
          models={models}
          accounts={accounts}
          onClose={() => setShowAddAgent(false)}
          onAdd={(name, model, avatar, color) => addAgent(activeWs.id, name, model, avatar, color)}
        />
      )}
    </div>
  );
}
