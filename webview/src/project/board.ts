import type { BrokenObjective, Objective, ObjectiveStatus, Priority } from "../state/useServer";

// The board's view of a project's objectives: dependencies both ways, where
// each objective stands, and the layout of the dependency graph. The server
// keeps the same relations for the lead (project/objectives.ts).

export function isBroken(o: Objective | BrokenObjective): o is BrokenObjective {
  return "error" in o;
}

export interface Relations {
  // Prerequisites not done yet.
  blockedBy: string[];
  // Objectives that list this one as a prerequisite.
  unblocks: string[];
  // Prerequisites given up; they never block.
  dropped: string[];
  // Prerequisites that are not objectives.
  missing: string[];
}

// Over every objective, archived ones included: an archived prerequisite
// that is done still counts as done.
export function relations(objectives: Objective[]): Map<string, Relations> {
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const out = new Map<string, Relations>(
    objectives.map((o) => [o.id, { blockedBy: [], unblocks: [], dropped: [], missing: [] }]),
  );
  for (const o of objectives) {
    const own = out.get(o.id)!;
    for (const dep of o.dependsOn) {
      const target = byId.get(dep);
      if (!target) {
        own.missing.push(dep);
        continue;
      }
      out.get(dep)!.unblocks.push(o.id);
      if (target.status === "dropped") own.dropped.push(dep);
      else if (target.status !== "done") own.blockedBy.push(dep);
    }
  }
  return out;
}

// Where an active objective stands, for the badge on its card.
export type Stage = "blocked" | "ready" | "in progress" | "review";

export function stage(o: Objective, rel: Relations): Stage | null {
  if (o.status !== "active") return null;
  if (o.tasks.some((t) => t.state === "doing")) return "in progress";
  if (o.tasks.some((t) => t.state === "review")) return "review";
  return rel.blockedBy.length ? "blocked" : "ready";
}

export function progress(o: Objective): { done: number; total: number } {
  const live = o.tasks.filter((t) => t.state !== "dropped");
  return { done: live.filter((t) => t.state === "done").length, total: live.length };
}

export function openDecisions(o: Objective): number {
  return o.decisions.filter((d) => !d.outcome).length;
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const STATUS_ORDER: Record<ObjectiveStatus, number> = { active: 0, later: 1, done: 2, dropped: 3 };

// Most pressing first: status, then priority, then most recently touched.
export function compareObjectives(a: Objective, b: Objective): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    b.updatedAt - a.updatedAt
  );
}

export interface BoardFilter {
  area: string | null;
  statuses: ObjectiveStatus[];
  search: string;
  // The archive instead of the board; statuses do not apply there.
  archive: boolean;
}

export function matches(o: Objective, f: BoardFilter): boolean {
  if (!!o.archived !== f.archive) return false;
  if (f.area && o.area !== f.area) return false;
  if (!f.archive && !f.statuses.includes(o.status)) return false;
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [o.id, o.title, o.goal, o.reason ?? "", ...o.tasks.map((t) => t.text)]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

// Every area with how many of its objectives the filter shows, so the
// numbers in the nav are the cards the user gets.
export function areaCounts(
  objectives: Objective[],
  filter: BoardFilter,
): Array<{ area: string; count: number }> {
  const names = [...new Set(objectives.map((o) => o.area))].sort();
  return names.map((area) => ({
    area,
    count: objectives.filter((o) => matches(o, { ...filter, area })).length,
  }));
}

export interface GraphLayout {
  // Left to right: an objective sits one column right of its deepest
  // prerequisite among those shown.
  columns: Objective[][];
  // Shown objectives with no edge to any other shown one.
  independent: Objective[];
}

// Columns by depth, rows ordered so that connected objectives sit near each
// other (average position of their neighbours, a forward, backward and
// forward pass). A cycle (only reachable by hand edits; the tools refuse
// them) is cut where it is found.
export function layout(objectives: Objective[]): GraphLayout {
  const shown = new Map(objectives.map((o) => [o.id, o]));
  const children = new Map<string, string[]>();
  for (const o of objectives) {
    for (const dep of o.dependsOn) {
      if (shown.has(dep)) children.set(dep, [...(children.get(dep) ?? []), o.id]);
    }
  }
  const prereqs = (o: Objective) => o.dependsOn.filter((d) => shown.has(d));
  const linked = (o: Objective) => prereqs(o).length > 0 || (children.get(o.id)?.length ?? 0) > 0;

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (o: Objective): number => {
    const known = depth.get(o.id);
    if (known !== undefined) return known;
    if (visiting.has(o.id)) return 0;
    visiting.add(o.id);
    let d = 0;
    for (const dep of prereqs(o)) d = Math.max(d, visit(shown.get(dep)!) + 1);
    visiting.delete(o.id);
    depth.set(o.id, d);
    return d;
  };

  const columns: Objective[][] = [];
  const independent: Objective[] = [];
  for (const o of [...objectives].sort(compareObjectives)) {
    if (!linked(o)) independent.push(o);
    else (columns[visit(o)] ??= []).push(o);
  }
  const dense = columns.filter(Boolean);

  const row = new Map<string, number>();
  const place = (col: Objective[]) => col.forEach((o, i) => row.set(o.id, i));
  const mean = (ids: string[]) => {
    const rows = ids.map((id) => row.get(id)).filter((r): r is number => r !== undefined);
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : undefined;
  };
  const reorder = (col: Objective[], key: (o: Objective) => number | undefined) => {
    const keyed = col.map((o, i) => ({ o, k: key(o) ?? row.get(o.id) ?? i }));
    keyed.sort((a, b) => a.k - b.k || compareObjectives(a.o, b.o));
    col.splice(0, col.length, ...keyed.map((x) => x.o));
    place(col);
  };
  dense.forEach(place);
  const forward = () => dense.slice(1).forEach((c) => reorder(c, (o) => mean(prereqs(o))));
  forward();
  for (let i = dense.length - 2; i >= 0; i--) {
    reorder(dense[i], (o) => mean(children.get(o.id) ?? []));
  }
  forward();
  return { columns: dense, independent };
}

// Everything upstream (prerequisites, transitively) or downstream of `id`.
export function reach(objectives: Objective[], id: string, direction: "up" | "down"): Set<string> {
  const rel = relations(objectives);
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const next = (x: string) =>
    direction === "up"
      ? (byId.get(x)?.dependsOn.filter((d) => byId.has(d)) ?? [])
      : (rel.get(x)?.unblocks ?? []);
  const seen = new Set<string>();
  const stack = next(id);
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x) || x === id) continue;
    seen.add(x);
    stack.push(...next(x));
  }
  return seen;
}
