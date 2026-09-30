import { useEffect, useRef, useState, type ReactNode } from "react";

export const PANEL_MIN_WIDTH = 300;

// Width until the user drags one: lists (agents, tasks) and code grow with
// the window, so a full-screen window gives them the room it has.
export function autoPanelWidth(kind: "list" | "wide", viewport: number): number {
  const [share, min, max] = kind === "wide" ? [0.42, 560, 1100] : [0.24, 380, 560];
  return Math.round(Math.min(max, Math.max(min, viewport * share)));
}

// A panel beside the chat: floating over it, pinned so the chat makes room,
// or maximised over the whole chat area (`inset` from the window's left
// edge). The left edge drags to resize, a double-click there goes back to
// the automatic width; on phones it is a full-screen sheet.
export function SidePanel({
  title,
  kind = "list",
  pinned,
  maximized,
  inset,
  width,
  onPin,
  onMaximize,
  onClose,
  onWidth,
  flush,
  children,
}: {
  title: string;
  kind?: "list" | "wide";
  pinned: boolean;
  maximized: boolean;
  inset: number;
  // Null: the automatic width.
  width: number | null;
  onPin: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onWidth: (width: number | null) => void;
  // The content fills the panel and scrolls itself.
  flush?: boolean;
  children: ReactNode;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const self = useRef<HTMLElement>(null);
  // A width saved on a wide screen must not bury the chat on a narrow one.
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const maxWidth = Math.max(PANEL_MIN_WIDTH, viewport * 0.7);
  const shown = Math.round(Math.min(width ?? autoPanelWidth(kind, viewport), maxWidth));
  // Focus moves in, so Escape closes the panel just opened.
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  return (
    <aside
      ref={self}
      tabIndex={-1}
      className={`side-panel ${pinned ? "docked" : "floating"}${maximized ? " maximized" : ""}`}
      style={maximized ? { left: inset } : { width: shown }}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !e.nativeEvent.isComposing) onClose();
      }}
    >
      {!maximized && (
        <div
          className="side-panel-resize"
          title="Drag to resize · double-click for the automatic width"
          onDoubleClick={() => onWidth(null)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, w: shown };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const next = drag.current.w + drag.current.x - e.clientX;
            onWidth(Math.round(Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, next))));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
      )}
      <header className="side-panel-head">
        <span className="side-panel-title">{title}</span>
        <button
          className="side-panel-btn side-panel-max"
          aria-pressed={maximized}
          title={maximized ? "Back beside the chat" : "Maximise over the chat"}
          onClick={onMaximize}
        >
          <Icon d={maximized ? RESTORE : MAXIMIZE} />
        </button>
        {!maximized && (
          <button
            className="side-panel-btn side-panel-pin"
            aria-pressed={pinned}
            title={pinned ? "Float over the chat" : "Pin beside the chat"}
            onClick={onPin}
          >
            <Icon d={PIN} />
          </button>
        )}
        <button
          className="side-panel-btn side-panel-close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <Icon d={CLOSE} />
        </button>
      </header>
      <div className={`side-panel-body${flush ? " flush" : ""}`}>{children}</div>
    </aside>
  );
}

const MAXIMIZE = "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10";
const RESTORE = "M6 2.5V6H2.5M10 2.5V6h3.5M10 13.5V10h3.5M6 13.5V10H2.5";
const PIN = "M2.5 3.5h11v9h-11zM10 3.5v9";
const CLOSE = "M4 4l8 8M12 4l-8 8";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
