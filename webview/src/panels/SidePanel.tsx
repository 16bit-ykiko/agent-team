import { useEffect, useRef, useState, type ReactNode } from "react";

export const PANEL_MIN_WIDTH = 300;

// A panel beside the chat: floating over it, or pinned so the chat makes
// room. The left edge drags to resize; on phones it is a full-screen sheet.
export function SidePanel({
  title,
  pinned,
  width,
  onPin,
  onClose,
  onWidth,
  flush,
  children,
}: {
  title: string;
  pinned: boolean;
  width: number;
  onPin: () => void;
  onClose: () => void;
  onWidth: (width: number) => void;
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
  const shown = Math.round(Math.min(width, maxWidth));
  // Focus moves in, so Escape closes the panel just opened.
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  return (
    <aside
      ref={self}
      tabIndex={-1}
      className={`side-panel ${pinned ? "docked" : "floating"}`}
      style={{ width: shown }}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !e.nativeEvent.isComposing) onClose();
      }}
    >
      <div
        className="side-panel-resize"
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
      <header className="side-panel-head">
        <span className="side-panel-title">{title}</span>
        <button
          className="side-panel-pin"
          aria-pressed={pinned}
          title={pinned ? "Float over the chat" : "Pin beside the chat"}
          onClick={onPin}
        >
          {pinned ? "⇤" : "⇥"}
        </button>
        <button className="side-panel-close" aria-label={`Close ${title}`} onClick={onClose}>
          ×
        </button>
      </header>
      <div className={`side-panel-body${flush ? " flush" : ""}`}>{children}</div>
    </aside>
  );
}
