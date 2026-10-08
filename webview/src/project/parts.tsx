import type { ReactNode } from "react";

// Pieces the board's two views share.

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bp-section">
      <h4 className="bp-section-title">{title}</h4>
      {children}
    </section>
  );
}

// One filter, whatever it filters by: its label and the rows it gives.
export function FilterChip({
  label,
  count,
  pressed,
  onClick,
  className,
  title,
  disabled,
}: {
  label: ReactNode;
  count: number;
  pressed: boolean;
  onClick: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={className ? `bp-chip ${className}` : "bp-chip"}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {label} <span className="bp-chip-count">{count}</span>
    </button>
  );
}
