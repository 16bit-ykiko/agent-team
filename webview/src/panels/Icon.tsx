// The panels' icons: 16px line drawings in one stroke, so the rail, the
// panel headers and the row actions read as one family.
export const ICONS = {
  board: "M2.5 3.5h11v9h-11zM6.2 3.5v9M9.8 3.5v9",
  agents: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.2 2.6-3.5 5-3.5s4.4 1.3 5 3.5",
  tasks: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 5v3.2l2 1.3",
  files: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  maximize: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  restore: "M6 2.5V6H2.5M10 2.5V6h3.5M10 13.5V10h3.5M6 13.5V10H2.5",
  pin: "M2.5 3.5h11v9h-11zM10 3.5v9",
  close: "M4 4l8 8M12 4l-8 8",
  clear: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7",
  up: "M8 13V3M4 7l4-4 4 4",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
