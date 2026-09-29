import { useRef, type ReactNode } from "react";

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
  return (
    <aside
      className={`side-panel ${pinned ? "docked" : "floating"}`}
      style={{ width }}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !e.nativeEvent.isComposing) onClose();
      }}
    >
      <div
        className="side-panel-resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, w: width };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth * 0.7);
          const next = drag.current.w + drag.current.x - e.clientX;
          onWidth(Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, next))));
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
