import { checkId, type Objective } from "./objectives";
import {
  EVIDENCE,
  GROUP_PATTERN,
  ISSUE_ID_PATTERN,
  ISSUE_STATES,
  checkModuleId,
  linkedObjectives,
  locate,
  type Evidence,
  type Issue,
  type IssueGroup,
  type IssueModule,
  type IssueState,
  type IssueStore,
  type Located,
} from "./issues";

// What the issue tools do over one project's IssueStore, as text for the
// model. Errors are thrown before anything is written.

export interface IssueFilter {
  module?: string;
  states?: IssueState[];
  evidence?: Evidence[];
  tag?: string;
  objective?: string;
  query?: string;
}

// Fields to set on an issue; one without an id, or with an id not in use,
// is created. Given lists replace the old ones; "" clears evidence, and a
// group of "" takes it out of its group.
export interface IssuePatch {
  id?: string;
  module?: string;
  group?: string;
  state?: IssueState;
  evidence?: Evidence | "";
  tags?: string[];
  text?: string;
  objectives?: string[];
}

// A module (no group) or one of its groups; remove drops an empty one.
export interface GroupPatch {
  module: string;
  group?: string;
  title?: string;
  notes?: string;
  objectives?: string[];
  remove?: boolean;
}

// Of the listing: characters of an issue's text on its line, and in all.
const LINE_TEXT = 140;
const OUTPUT_CAP = 60_000;

const OPEN: IssueState[] = ["open", "decision"];

export class IssueBoard {
  constructor(
    private store: IssueStore,
    private objectives: () => Objective[],
  ) {}

  list(f: IssueFilter): string {
    const entries = this.store.list();
    const modules = entries.filter((m): m is IssueModule => !("error" in m));
    if (f.module) this.module(modules, f.module);
    const states = f.states?.length ? f.states : OPEN;
    const q = f.query?.toLowerCase();
    const keep = (at: Located) =>
      states.includes(at.issue.state) &&
      (!f.evidence?.length || (!!at.issue.evidence && f.evidence.includes(at.issue.evidence))) &&
      (!f.tag || at.issue.tags.includes(f.tag)) &&
      (!f.objective || linkedObjectives(at).includes(f.objective)) &&
      (!q || `${at.issue.id}\n${at.issue.text}`.toLowerCase().includes(q));
    const all = [...locate(modules).byId.values()];
    const out: string[] = [
      summary(
        all.map((x) => x.issue),
        modules.length,
      ),
    ];
    let shown = 0;
    let cut = 0;
    let size = 0;
    for (const m of modules) {
      if (f.module && m.id !== f.module) continue;
      const parts: Array<{ group?: IssueGroup; items: Located[] }> = [
        { items: m.issues.map((issue) => ({ issue, module: m })) },
        ...m.groups.map((group) => ({
          group,
          items: group.issues.map((issue) => ({ issue, module: m, group })),
        })),
      ];
      const lines: string[] = [];
      for (const { group, items } of parts) {
        const kept = items.filter(keep);
        if (kept.length === 0) continue;
        if (group) {
          const notes = group.notes ? ` — ${oneLine(group.notes, 200)}` : "";
          lines.push(`### ${m.id}/${group.id} ${group.title}${notes}`);
        }
        for (const at of kept) lines.push(issueLine(at.issue));
        shown += kept.length;
      }
      if (lines.length === 0) continue;
      const block = [`\n## ${m.id} — ${m.title}`, ...lines].join("\n");
      if (size + block.length > OUTPUT_CAP) {
        cut += lines.filter((l) => l.startsWith("- ")).length;
        continue;
      }
      out.push(block);
      size += block.length;
    }
    for (const b of entries.filter((m) => "error" in m)) {
      out.push(`- ${b.id}.toml UNREADABLE: ${"error" in b ? b.error : ""}`);
    }
    if (shown === 0) out.push(`(no ${states.join(" or ")} issues match)`);
    if (cut) out.push(`(${cut} more not shown: narrow it by module, tag or query)`);
    return out.join("\n");
  }

  // One issue in full, or a module (or one of its groups) with all its
  // issues in full.
  read(id?: string, moduleId?: string, groupId?: string): string {
    const modules = this.modules();
    if (id) {
      const at = this.find(modules, id);
      const objectives = new Map(this.objectives().map((o) => [o.id, o]));
      const ref = (oid: string) => {
        const o = objectives.get(oid);
        return o
          ? `${oid} (${o.status}${o.archived ? ", archived" : ""}) ${o.title}`
          : `${oid} (missing)`;
      };
      const where = at.group
        ? `${at.module.id}/${at.group.id} — ${at.module.title} › ${at.group.title}`
        : `${at.module.id} — ${at.module.title}`;
      return [
        `${at.issue.id} [${flags(at.issue).join(", ") || "open"}]`,
        `in ${where}`,
        ...(at.group?.notes ? [`group notes: ${at.group.notes}`] : []),
        `objectives: ${linkedObjectives(at).map(ref).join("; ") || "none"}`,
        "",
        at.issue.text,
      ].join("\n");
    }
    if (!moduleId) throw new Error("Give an issue id, or a module (and group)");
    const m = this.module(modules, moduleId);
    const group = groupId === undefined ? undefined : this.group(m, groupId);
    const out = [`# ${m.id} — ${m.title}`];
    if (m.objectives.length) out.push(`objectives: ${m.objectives.join(", ")}`);
    if (m.notes && !group) out.push("", m.notes);
    const full = (x: Issue) => ["", `## ${x.id} [${flags(x).join(", ") || "open"}]`, x.text];
    if (!group) for (const x of m.issues) out.push(...full(x));
    for (const g of group ? [group] : m.groups) {
      out.push("", `# ${m.id}/${g.id} ${g.title}`);
      if (g.objectives.length) out.push(`objectives: ${g.objectives.join(", ")}`);
      if (g.notes) out.push("", g.notes);
      for (const x of g.issues) out.push(...full(x));
    }
    const text = out.join("\n");
    return text.length > OUTPUT_CAP
      ? `${text.slice(0, OUTPUT_CAP)}\n…(cut: read one group or issue)`
      : text;
  }

  write(patches: IssuePatch[]): string {
    if (patches.length === 0) return "Nothing to write.";
    const modules = new Map(this.modules().map((m) => [m.id, structuredClone(m)]));
    const touched = new Set<string>();
    const out: string[] = [];
    const known = new Set(this.objectives().map((o) => o.id));
    const unknown = new Set<string>();
    for (const [i, p] of patches.entries()) {
      const where = patches.length > 1 ? `issues[${i}]: ` : "";
      try {
        if (p.id !== undefined && !ISSUE_ID_PATTERN.test(p.id)) {
          throw new Error(`id "${p.id}": no spaces, at most 40 characters`);
        }
        if (p.state !== undefined && !ISSUE_STATES.includes(p.state)) {
          throw new Error(`state must be one of ${ISSUE_STATES.join(", ")}`);
        }
        if (p.evidence && !EVIDENCE.includes(p.evidence)) {
          throw new Error(`evidence must be one of ${EVIDENCE.join(", ")}`);
        }
        if (p.text === "") throw new Error("text cannot be empty");
        for (const o of p.objectives ?? []) {
          checkId(o);
          if (!known.has(o)) unknown.add(o);
        }
        const all = [...modules.values()];
        const { byId, twice } = locate(all);
        if (p.id !== undefined && twice.has(p.id)) {
          throw new Error(`${p.id} is in more than one place; fix the files by hand`);
        }
        const at = p.id === undefined ? undefined : byId.get(p.id);
        if (!at) {
          if (!p.module) throw new Error("a new issue needs a module");
          if (!p.text) throw new Error("a new issue needs its text");
          const m = this.module(all, p.module);
          const group = p.group ? this.group(m, p.group) : undefined;
          const issue: Issue = {
            id: p.id ?? this.store.allocate(byId.keys()),
            state: p.state ?? "open",
            ...(p.evidence && { evidence: p.evidence }),
            tags: unique(p.tags ?? []),
            text: p.text,
            objectives: unique(p.objectives ?? []),
          };
          (group ?? m).issues.push(issue);
          touched.add(m.id);
          out.push(`Created ${issue.id} in ${m.id}${group ? `/${group.id}` : ""}.`);
          continue;
        }
        const issue: Issue = {
          ...at.issue,
          ...(p.state !== undefined && { state: p.state }),
          ...(p.tags !== undefined && { tags: unique(p.tags) }),
          ...(p.text !== undefined && { text: p.text }),
          ...(p.objectives !== undefined && { objectives: unique(p.objectives) }),
        };
        if (p.evidence === "") delete issue.evidence;
        else if (p.evidence !== undefined) issue.evidence = p.evidence;
        const target = p.module === undefined ? at.module : this.module(all, p.module);
        const targetGroup =
          p.group === undefined
            ? p.module === undefined || p.module === at.module.id
              ? at.group
              : undefined
            : p.group === ""
              ? undefined
              : this.group(target, p.group);
        // Edited where it is, it keeps its place; moved, it goes last.
        const from = at.group ?? at.module;
        const to = targetGroup ?? target;
        const index = from.issues.indexOf(at.issue);
        if (to === from) {
          from.issues[index] = issue;
        } else {
          from.issues.splice(index, 1);
          to.issues.push(issue);
        }
        touched.add(at.module.id);
        touched.add(target.id);
        const moved =
          to !== from ? ` Moved to ${target.id}${targetGroup ? `/${targetGroup.id}` : ""}.` : "";
        out.push(`Updated ${issue.id}.${moved}`);
      } catch (e) {
        throw new Error(`${where}${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.save(modules, touched);
    if (unknown.size) out.push(`Not objectives (yet): ${[...unknown].join(", ")}.`);
    return out.join("\n");
  }

  // Deletes fixed issues. What they said goes back in the result, so the
  // call keeps them findable in the history.
  close(ids: string[], fixedBy: string): string {
    if (ids.length === 0) throw new Error("Give the ids of the issues to close");
    if (!fixedBy.trim()) throw new Error("Say what fixed them (a PR, a commit)");
    const modules = new Map(this.modules().map((m) => [m.id, structuredClone(m)]));
    const all = [...modules.values()];
    const found = [...new Set(ids)].map((id) => this.find(all, id));
    const touched = new Set<string>();
    for (const at of found) {
      const from = at.group ?? at.module;
      from.issues.splice(from.issues.indexOf(at.issue), 1);
      touched.add(at.module.id);
    }
    this.save(modules, touched);
    return [
      `Closed ${found.map((x) => x.issue.id).join(", ")}, fixed by ${fixedBy.trim()}.`,
      ...found.flatMap((at) => [
        "",
        `${at.issue.id} [${flags(at.issue).join(", ") || "open"}] in ${at.module.id}${at.group ? `/${at.group.id}` : ""}`,
        at.issue.text,
      ]),
    ].join("\n");
  }

  writeGroup(p: GroupPatch): string {
    checkModuleId(p.module);
    for (const o of p.objectives ?? []) checkId(o);
    if (p.title === "") throw new Error("title cannot be empty");
    const current = this.store.get(p.module);
    if (p.group === undefined) {
      if (p.remove) {
        if (!current) throw new Error(`No module ${p.module}`);
        const left =
          current.issues.length + current.groups.reduce((n, g) => n + g.issues.length, 0);
        if (left) throw new Error(`${p.module} still has ${left} issues; close or move them first`);
        this.store.remove(p.module);
        return `Removed module ${p.module}.`;
      }
      if (!current && !p.title) throw new Error(`${p.module} does not exist yet: give it a title`);
      const next: IssueModule = {
        ...(current ?? {
          id: p.module,
          title: "",
          objectives: [],
          issues: [],
          groups: [],
          updatedAt: 0,
        }),
        ...(p.title !== undefined && { title: p.title }),
        ...(p.objectives !== undefined && { objectives: unique(p.objectives) }),
        updatedAt: Date.now(),
      };
      if (p.notes === "") delete next.notes;
      else if (p.notes !== undefined) next.notes = p.notes;
      this.store.write(next);
      return `${current ? "Updated" : "Created"} module ${p.module}.`;
    }
    if (!current) throw new Error(`No module ${p.module}: create it first (no group)`);
    if (!GROUP_PATTERN.test(p.group)) {
      throw new Error(`Bad group "${p.group}": use lowercase letters, digits, . and -`);
    }
    const m = structuredClone(current);
    const at = m.groups.findIndex((g) => g.id === p.group);
    if (p.remove) {
      if (at < 0) throw new Error(`No group ${p.group} in ${p.module}`);
      const left = m.groups[at].issues.length;
      if (left)
        throw new Error(
          `${p.module}/${p.group} still has ${left} issues; close or move them first`,
        );
      m.groups.splice(at, 1);
      this.store.write({ ...m, updatedAt: Date.now() });
      return `Removed group ${p.module}/${p.group}.`;
    }
    if (at < 0 && !p.title)
      throw new Error(`${p.module}/${p.group} does not exist yet: give it a title`);
    const g: IssueGroup = {
      ...(at < 0 ? { id: p.group, title: "", objectives: [], issues: [] } : m.groups[at]),
      ...(p.title !== undefined && { title: p.title }),
      ...(p.objectives !== undefined && { objectives: unique(p.objectives) }),
    };
    if (p.notes === "") delete g.notes;
    else if (p.notes !== undefined) g.notes = p.notes;
    if (at < 0) m.groups.push(g);
    else m.groups[at] = g;
    this.store.write({ ...m, updatedAt: Date.now() });
    return `${at < 0 ? "Created" : "Updated"} group ${p.module}/${p.group}.`;
  }

  // The open issues linked to each objective, and how many are accepted.
  linked(): Map<string, { open: Located[]; accepted: number }> {
    const out = new Map<string, { open: Located[]; accepted: number }>();
    for (const at of locate(this.store.list()).byId.values()) {
      for (const o of linkedObjectives(at)) {
        const entry = out.get(o) ?? { open: [], accepted: 0 };
        if (at.issue.state === "accepted") entry.accepted++;
        else entry.open.push(at);
        out.set(o, entry);
      }
    }
    return out;
  }

  // One line for project_status.
  summary(): string {
    const modules = this.store.list().filter((m): m is IssueModule => !("error" in m));
    if (modules.length === 0) return "(none)";
    return summary(
      [...locate(modules).byId.values()].map((x) => x.issue),
      modules.length,
    );
  }

  private modules(): IssueModule[] {
    const entries = this.store.list();
    const broken = entries.filter((m) => "error" in m);
    if (broken.length) {
      // A broken file may hold the issue asked for; writing around it would
      // hand out its ids again.
      throw new Error(
        `Unreadable issue files: ${broken.map((b) => `${b.id}.toml`).join(", ")}; fix them first`,
      );
    }
    return entries as IssueModule[];
  }

  private module(modules: IssueModule[], id: string): IssueModule {
    checkModuleId(id);
    const m = modules.find((x) => x.id === id);
    if (!m) {
      const names = modules.map((x) => x.id).join(", ");
      throw new Error(
        `No module ${id}${names ? ` (there are: ${names})` : ""}; write_issue_group makes one`,
      );
    }
    return m;
  }

  private group(m: IssueModule, id: string): IssueGroup {
    const g = m.groups.find((x) => x.id === id);
    if (!g) {
      const names = m.groups.map((x) => x.id).join(", ");
      throw new Error(`No group ${id} in ${m.id}${names ? ` (there are: ${names})` : ""}`);
    }
    return g;
  }

  private find(modules: IssueModule[], id: string): Located {
    const { byId, twice } = locate(modules);
    if (twice.has(id)) throw new Error(`${id} is in more than one place; fix the files by hand`);
    const at = byId.get(id);
    if (!at) throw new Error(`No issue ${id}`);
    return at;
  }

  private save(modules: Map<string, IssueModule>, touched: Set<string>): void {
    const now = Date.now();
    for (const id of touched) this.store.write({ ...modules.get(id)!, updatedAt: now });
  }
}

function flags(x: Issue): string[] {
  return [x.state !== "open" ? x.state : "", x.evidence ?? "", ...x.tags].filter(Boolean);
}

function issueLine(x: Issue): string {
  const f = flags(x);
  return `- ${x.id}${f.length ? ` [${f.join(", ")}]` : ""} ${oneLine(x.text, LINE_TEXT)}`;
}

function summary(issues: Issue[], modules: number): string {
  const n = (s: IssueState) => issues.filter((x) => x.state === s).length;
  return `${n("open")} open, ${n("decision")} to decide, ${n("accepted")} accepted, in ${modules} module${modules === 1 ? "" : "s"}.`;
}

function unique(v: string[]): string[] {
  return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
