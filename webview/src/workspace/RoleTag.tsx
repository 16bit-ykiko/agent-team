import type { ProjectLink } from "../state/useServer";

// A project session's role beside its name: the lead, or a worker kept to
// its own task. `name` already saying "lead" makes the tag redundant.
export function RoleTag({ link, name }: { link?: ProjectLink; name?: string }) {
  if (link?.role === "lead") {
    return name && /\blead\b/i.test(name) ? null : <span className="task-role-tag">lead</span>;
  }
  if (!link?.isolated) return null;
  return (
    <span
      className="task-role-tag"
      title="Sees only its own task: none of the board, notes, issues or other sessions"
    >
      isolated
    </span>
  );
}
