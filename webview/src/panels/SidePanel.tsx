import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export const PANEL_MIN_WIDTH = 300;
// The chat beside (or under) a panel keeps at least this much.
const MIN_CHAT_WIDTH = 360;
const RAIL_WIDTH = 44;

function useViewportWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

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
  subtitle,
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
  // What it covers, under the title (the chat header has the same two rows).
  subtitle?: string;
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
  const viewport = useViewportWidth();
  const maxWidth = Math.max(
    PANEL_MIN_WIDTH,
    Math.min(viewport * 0.7, viewport - inset - RAIL_WIDTH - MIN_CHAT_WIDTH),
  );
  const shown = Math.round(Math.min(width ?? autoPanelWidth(kind, viewport), maxWidth));
  // Pinned beside a chat that would keep less than its room, it floats over it.
  const docked = pinned && viewport - inset - RAIL_WIDTH - MIN_CHAT_WIDTH >= PANEL_MIN_WIDTH;
  // Focus moves in, so Escape closes the panel just opened.
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  return (
    <aside
      ref={self}
      tabIndex={-1}
      className={`side-panel ${docked ? "docked" : "floating"}${maximized ? " maximized" : ""}`}
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
        <div className="side-panel-titles">
          <span className="side-panel-title">{title}</span>
          {subtitle && <span className="side-panel-sub">{subtitle}</span>}
        </div>
        <button
          className="side-panel-btn side-panel-max"
          aria-pressed={maximized}
          title={maximized ? "Back beside the chat" : "Maximise over the chat"}
          onClick={onMaximize}
        >
          <Icon name={maximized ? "restore" : "maximize"} />
        </button>
        {!maximized && (
          <button
            className="side-panel-btn side-panel-pin"
            aria-pressed={pinned}
            title="Pin beside the chat"
            onClick={onPin}
          >
            <Icon name="pin" />
          </button>
        )}
        <button
          className="side-panel-btn side-panel-close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className={`side-panel-body${flush ? " flush" : ""}`}>{children}</div>
    </aside>
  );
}
