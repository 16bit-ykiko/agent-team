import { Icon, type IconName } from "./Icon";

export interface RailItem {
  id: string;
  label: string;
  icon: IconName;
  active: boolean;
  // A count worth noticing (sessions working, tasks running).
  badge?: number;
  // Opens a page over everything rather than a panel beside the chat.
  page?: boolean;
  onClick: () => void;
}

// The panel buttons: a column at the window's right edge on desktop, a row
// in the chat header on phones (the same items, two placements).
export function Rail({ items, className }: { items: RailItem[]; className: string }) {
  return (
    <nav className={className} aria-label="Panels">
      {items.map((i) => (
        <button
          key={i.id}
          className={`rail-btn${i.page ? " rail-page" : ""}`}
          aria-label={i.label}
          aria-pressed={i.active}
          title={i.label}
          onClick={i.onClick}
        >
          <Icon name={i.icon} />
          {!!i.badge && <span className="rail-badge">{i.badge}</span>}
        </button>
      ))}
    </nav>
  );
}
