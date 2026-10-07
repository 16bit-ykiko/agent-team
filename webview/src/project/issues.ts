import type {
  BrokenIssueModule,
  Evidence,
  Issue,
  IssueGroup,
  IssueModule,
  IssueModules,
  IssueState,
} from "../state/useServer";

// The board's view of a project's issues: each with where it sits, the
// filters, and the links to objectives both ways. The server keeps the same
// links for the agents (project/issues.ts).

export interface IssueEntry {
  issue: Issue;
  module: IssueModule;
  group?: IssueGroup;
}

export function isBrokenModule(m: IssueModule | BrokenIssueModule): m is BrokenIssueModule {
  return "error" in m;
}

// In file order: a module's issues in no group, then its groups'.
export function issueEntries(modules: IssueModules): IssueEntry[] {
  const out: IssueEntry[] = [];
  for (const module of modules) {
    if (isBrokenModule(module)) continue;
    for (const issue of module.issues) out.push({ issue, module });
    for (const group of module.groups) {
      for (const issue of group.issues) out.push({ issue, module, group });
    }
  }
  return out;
}

// Its own objectives, its group's and its module's.
export function linkedObjectives(e: IssueEntry): string[] {
  return [
    ...new Set([...e.issue.objectives, ...(e.group?.objectives ?? []), ...e.module.objectives]),
  ];
}

// The issues linked to each objective.
export function issuesByObjective(entries: IssueEntry[]): Map<string, IssueEntry[]> {
  const out = new Map<string, IssueEntry[]>();
  for (const e of entries) {
    for (const o of linkedObjectives(e)) out.set(o, [...(out.get(o) ?? []), e]);
  }
  return out;
}

export const OPEN_STATES: IssueState[] = ["open", "decision"];

export function isOpen(e: IssueEntry): boolean {
  return OPEN_STATES.includes(e.issue.state);
}

export interface IssueFilter {
  module: string | null;
  states: IssueState[];
  // None picked: any.
  evidence: Evidence[];
  // Any of them; none picked: any.
  tags: string[];
  search: string;
}

export const DEFAULT_ISSUE_FILTER: IssueFilter = {
  module: null,
  states: OPEN_STATES,
  evidence: [],
  tags: [],
  search: "",
};

export function issueMatches(e: IssueEntry, f: IssueFilter): boolean {
  if (f.module && e.module.id !== f.module) return false;
  if (!f.states.includes(e.issue.state)) return false;
  if (f.evidence.length && !(e.issue.evidence && f.evidence.includes(e.issue.evidence))) {
    return false;
  }
  if (f.tags.length && !e.issue.tags.some((t) => f.tags.includes(t))) return false;
  const q = f.search.trim().toLowerCase();
  if (!q) return true;
  return [e.issue.id, e.issue.text, ...e.issue.tags].join("\n").toLowerCase().includes(q);
}

// Every module with how many of its issues the filter shows, so the numbers
// in the nav are the rows the user gets.
export function moduleCounts(
  modules: IssueModule[],
  entries: IssueEntry[],
  f: IssueFilter,
): Array<{ module: IssueModule; count: number }> {
  return modules.map((module) => ({
    module,
    count: entries.filter((e) => e.module === module && issueMatches(e, { ...f, module: null }))
      .length,
  }));
}

// The tags in use among what the other filters show, most used first.
export function tagCounts(
  entries: IssueEntry[],
  f: IssueFilter,
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!issueMatches(e, { ...f, tags: [] })) continue;
    for (const t of e.issue.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Its first paragraph, on one line: what the list shows of it.
export function issueSummary(text: string): string {
  return (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s*\n\s*/g, " ");
}

// Matches the given ids where they stand alone in text: "10-06#1" not in
// "10-06#14", nor "F7" in "F71"; Chinese right next to one is no part of it.
export function issueIdPattern(ids: string[]): RegExp | null {
  if (ids.length === 0) return null;
  const alternatives = [...new Set(ids)]
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9_#-])(?:${alternatives.join("|")})(?![A-Za-z0-9_#])`, "g");
}
