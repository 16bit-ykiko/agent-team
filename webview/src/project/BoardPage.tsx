import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  IssueModule,
  IssueModules,
  Objective,
  ObjectiveStatus,
  Project,
  TaskState,
} from "../state/useServer";
import { InlineMd, IssueRefContext, MdBlock, type IssueRefs } from "../chat/markdown";
import { isImeKeyEvent } from "../chat/ime";
import { formatRelative } from "../format";
import { Icon } from "../panels/Icon";
import {
  areaCounts,
  compareObjectives,
  isBroken,
  layout,
  matches,
  openDecisions,
  progress,
  reach,
  relations,
  stage,
  type BoardFilter,
  type Relations,
} from "./board";
import {
  DEFAULT_ISSUE_FILTER,
  duplicateIds,
  isBrokenModule,
  isOpen,
  issueEntries,
  issueIdPattern,
  issueMatches,
  issueSummary,
  issuesByObjective,
  type IssueEntry,
  type IssueFilter,
} from "./issues";
import { DetailSection, IssueDetail, IssueList, IssueNav } from "./IssuesView";

// A worker session as the board shows it.
export interface SessionInfo {
  name: string;
  state: "working" | "idle" | "archived";
}

const STATUSES: ObjectiveStatus[] = ["active", "later", "done", "dropped"];
const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  active: "Active",
  later: "Later",
  done: "Done",
  dropped: "Dropped",
};
const TASK_MARK: Record<TaskState, string> = {
  todo: "○",
  doing: "◐",
  review: "◎",
  done: "●",
  dropped: "⊘",
};

// Brings the element for `id` into view inside its scroller.
function reveal(root: HTMLElement | null, id: string | null): void {
  if (!root || !id) return;
  const el = [...root.querySelectorAll<HTMLElement>("[data-objective]")].find(
    (e) => e.dataset.objective === id,
  );
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

const NO_ISSUES: IssueEntry[] = [];
const NO_MODULES: IssueModules = [];

// The project's objectives on a page of their own: areas on the left, the
// objectives as cards or as a dependency graph in the middle, the selected
// one in full on the right, and the archive of finished ones; its issues
// the same way, a switch away. Read-only: the lead keeps the board, the
// user talks to it ("Ask the lead").
export const BoardPage = memo(function BoardPage({
  project,
  issues = NO_MODULES,
  sessions,
  onClose,
  onOpenSession,
  onAskLead,
  onRename,
  onArchive,
  onDelete,
}: {
  project: Project;
  issues?: IssueModules;
  sessions: Map<string, SessionInfo>;
  onClose: () => void;
  onOpenSession: (workspaceId: string) => void;
  onAskLead: ((objectiveId: string) => void) | null;
  onRename: (name: string) => void;
  // File the project away (true) or bring it back (false).
  onArchive?: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"objectives" | "issues">("objectives");
  const [view, setView] = useState<"list" | "graph">("list");
  const [filter, setFilter] = useState<BoardFilter>({
    area: null,
    statuses: ["active", "later"],
    search: "",
    archive: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>(DEFAULT_ISSUE_FILTER);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const objectives = useMemo(
    () => project.objectives.filter((o): o is Objective => !isBroken(o)),
    [project.objectives],
  );
  const broken = project.objectives.filter(isBroken);
  const rel = useMemo(() => relations(objectives), [objectives]);
  const shown = useMemo(
    () => objectives.filter((o) => matches(o, filter)).sort(compareObjectives),
    [objectives, filter],
  );
  const current = objectives.find((o) => o.id === selected) ?? null;
  const onBoard = objectives.filter((o) => !o.archived);
  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, onBoard.filter((o) => o.status === s).length]),
  ) as Record<ObjectiveStatus, number>;
  const archivedCount = objectives.length - onBoard.length;

  const modules = useMemo(
    () => issues.filter((m): m is IssueModule => !isBrokenModule(m)),
    [issues],
  );
  const brokenModules = issues.filter(isBrokenModule);
  const duplicates = useMemo(() => duplicateIds(issues), [issues]);
  const entries = useMemo(() => issueEntries(issues), [issues]);
  const byObjective = useMemo(() => issuesByObjective(entries), [entries]);
  const shownIssues = useMemo(
    () => entries.filter((e) => issueMatches(e, issueFilter)),
    [entries, issueFilter],
  );
  const currentIssue = entries.find((e) => e.issue.id === selectedIssue) ?? null;
  const issueFilterRef = useRef(issueFilter);
  issueFilterRef.current = issueFilter;
  const openIssues = entries.filter(isOpen).length;
  const issueRefs = useMemo<IssueRefs | null>(() => {
    const pattern = issueIdPattern(entries.map((e) => e.issue.id));
    return pattern
      ? {
          pattern,
          open: (id) => {
            const e = entries.find((x) => x.issue.id === id);
            setMode("issues");
            setSelectedIssue(id);
            // One the filter hides is shown with the defaults and its state.
            if (e && !issueMatches(e, issueFilterRef.current)) {
              setIssueFilter({
                ...DEFAULT_ISSUE_FILTER,
                states: [...new Set([...DEFAULT_ISSUE_FILTER.states, e.issue.state])],
              });
            }
          },
        }
      : null;
  }, [entries]);
  const openObjective = (id: string) => {
    const o = objectives.find((x) => x.id === id);
    setMode("objectives");
    setSelected(id);
    // One the filter hides is shown: its archive or its status, all areas.
    if (o && !matches(o, filter)) {
      setFilter({
        area: null,
        statuses: [...new Set([...filter.statuses, o.status])],
        search: "",
        archive: !!o.archived,
      });
    }
  };
  const detail = mode === "objectives" ? current : currentIssue;

  // A selection whose objective is gone (deleted by the lead) is dropped, so
  // it neither swallows the next Escape nor comes back by itself.
  useEffect(() => {
    if (selected && !current) setSelected(null);
  }, [selected, current]);
  useEffect(() => {
    if (selectedIssue && !currentIssue) setSelectedIssue(null);
  }, [selectedIssue, currentIssue]);

  // Focus moves into the page and goes back where it was on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    pageRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // A new view starts at its top-left, unless it opens on a selection: the
  // list (whose effects run first) has brought that into view.
  const opensOn = useRef(false);
  opensOn.current =
    mode === "issues"
      ? shownIssues.some((e) => e.issue.id === selectedIssue)
      : shown.some((o) => o.id === selected);
  useEffect(() => {
    if (!opensOn.current) mainRef.current?.scrollTo?.(0, 0);
  }, [mode, view, filter.archive]);

  // Escape steps back: clears the search, then leaves the details, then the
  // page. Not while composing text, and not for a dialog over the page.
  const showIssues = mode === "issues";
  const state = useRef({ issues: showIssues, selected, search: filter.search, onClose });
  state.current = {
    issues: showIssues,
    selected: showIssues ? selectedIssue : selected,
    search: showIssues ? issueFilter.search : filter.search,
    onClose,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      const target = e.target as Node | null;
      if (target instanceof Element && target.closest(".dialog-overlay")) return;
      const s = state.current;
      if (target === searchRef.current && s.search) {
        if (s.issues) setIssueFilter((f) => ({ ...f, search: "" }));
        else setFilter((f) => ({ ...f, search: "" }));
      } else if (s.selected) {
        if (s.issues) setSelectedIssue(null);
        else setSelected(null);
      } else {
        s.onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggleStatus = (s: ObjectiveStatus) =>
    setFilter((f) => ({
      ...f,
      statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s],
    }));
  const inView = objectives.filter((o) => matches(o, { ...filter, area: null })).length;

  return (
    <div className="board-overlay" onClick={onClose}>
      <div
        ref={pageRef}
        className={`board-page${detail ? " has-detail" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${project.name} objectives`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="bp-head">
          <ProjectName name={project.name} onRename={onRename} />
          <div className="bp-views bp-modes" role="group" aria-label="Show">
            <button aria-pressed={!showIssues} onClick={() => setMode("objectives")}>
              Objectives
            </button>
            <button aria-pressed={showIssues} onClick={() => setMode("issues")}>
              Issues{openIssues > 0 && <span className="bp-count">{openIssues}</span>}
            </button>
          </div>
          <span className="bp-summary">
            {showIssues
              ? `${entries.filter((e) => e.issue.state === "open").length} open · ${entries.filter((e) => e.issue.state === "decision").length} to decide · ${entries.filter((e) => e.issue.state === "accepted").length} accepted`
              : `${counts.active} active · ${counts.later} later · ${counts.done} done`}
          </span>
          <input
            ref={searchRef}
            className="bp-search"
            type="search"
            placeholder={showIssues ? "Search issues…" : "Search objectives…"}
            value={showIssues ? issueFilter.search : filter.search}
            onChange={(e) =>
              showIssues
                ? setIssueFilter((f) => ({ ...f, search: e.target.value }))
                : setFilter((f) => ({ ...f, search: e.target.value }))
            }
          />
          {!showIssues && (
            <div className="bp-views" role="group" aria-label="View">
              <button aria-pressed={view === "list"} onClick={() => setView("list")}>
                List
              </button>
              <button aria-pressed={view === "graph"} onClick={() => setView("graph")}>
                Dependencies
              </button>
            </div>
          )}
          <button className="side-panel-btn bp-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        {showIssues ? (
          <div className="bp-body">
            <IssueNav
              modules={modules}
              entries={entries}
              filter={issueFilter}
              onFilter={setIssueFilter}
            />
            <main className="bp-main" ref={mainRef}>
              {brokenModules.map((b) => (
                <div key={b.id} className="bp-broken">
                  <strong>{b.id}.toml</strong> cannot be read: {b.error}
                </div>
              ))}
              {duplicates.map((d) => (
                <div key={d.id} className="bp-broken">
                  <strong>{d.id}</strong> is in {d.modules.join(" and ")}
                  {d.modules.length === 1 ? " twice" : ""}: only the first is shown, and the agents
                  cannot change it until one is renamed.
                </div>
              ))}
              {entries.length === 0 ? (
                brokenModules.length === 0 && (
                  <div className="bp-empty">
                    No issues yet. The agents record the known defects here, each with its evidence
                    and the objectives that work on it, and delete one once its fix is merged.
                  </div>
                )
              ) : shownIssues.length === 0 ? (
                <div className="bp-empty">Nothing matches.</div>
              ) : (
                <IssueList
                  shown={shownIssues}
                  grouped={issueFilter.module === null}
                  selected={selectedIssue}
                  onSelect={setSelectedIssue}
                />
              )}
            </main>
            {currentIssue && (
              <IssueRefContext.Provider value={issueRefs}>
                <IssueDetail
                  key={currentIssue.issue.id}
                  entry={currentIssue}
                  objectives={objectives}
                  onSelectObjective={openObjective}
                  onClose={() => setSelectedIssue(null)}
                />
              </IssueRefContext.Provider>
            )}
          </div>
        ) : (
          <div className="bp-body">
            <nav className="bp-nav" aria-label="Filters">
              <div className="bp-areas">
                <button
                  className={`bp-area${filter.area === null ? " active" : ""}`}
                  onClick={() => setFilter((f) => ({ ...f, area: null }))}
                >
                  <span className="bp-area-name">All areas</span>
                  <span className="bp-count">{inView}</span>
                </button>
                {areaCounts(objectives, filter).map((a) => (
                  <button
                    key={a.area}
                    className={`bp-area${filter.area === a.area ? " active" : ""}${a.count ? "" : " empty"}`}
                    onClick={() => setFilter((f) => ({ ...f, area: a.area }))}
                  >
                    <span className="bp-area-name">{a.area}</span>
                    <span className="bp-count">{a.count}</span>
                  </button>
                ))}
              </div>
              <div className="bp-statuses" role="group" aria-label="Status">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    className={`bp-status-toggle st-${s}`}
                    aria-pressed={!filter.archive && filter.statuses.includes(s)}
                    disabled={filter.archive}
                    onClick={() => toggleStatus(s)}
                  >
                    {STATUS_LABEL[s]} <span className="bp-count">{counts[s]}</span>
                  </button>
                ))}
                <button
                  className="bp-status-toggle bp-archive-toggle"
                  aria-pressed={filter.archive}
                  onClick={() => {
                    setSelected(null);
                    setFilter((f) => ({ ...f, archive: !f.archive }));
                  }}
                >
                  Archive <span className="bp-count">{archivedCount}</span>
                </button>
              </div>
              {onArchive && (
                <button className="bp-archive" onClick={() => onArchive(!project.archivedAt)}>
                  {project.archivedAt ? "Restore project" : "Archive project"}
                </button>
              )}
              <button className="bp-delete" onClick={onDelete}>
                Delete project
              </button>
            </nav>

            <main className="bp-main" ref={mainRef}>
              {!filter.archive &&
                broken.map((b) => (
                  <div key={b.id} className="bp-broken">
                    <strong>{b.id}.toml</strong> cannot be read: {b.error}
                  </div>
                ))}
              {objectives.length === 0 ? (
                broken.length === 0 && (
                  <div className="bp-empty">
                    No objectives yet. Tell the lead what you want done, put off or dropped; it
                    keeps the board.
                  </div>
                )
              ) : shown.length === 0 ? (
                <div className="bp-empty">
                  {filter.archive && !filter.search && !filter.area
                    ? "Nothing archived yet. Finished and dropped objectives land here when the lead files them away."
                    : "Nothing matches."}
                </div>
              ) : view === "list" || filter.archive ? (
                <ObjectiveList
                  objectives={shown}
                  rel={rel}
                  grouped={filter.area === null}
                  selected={selected}
                  sessions={sessions}
                  issues={byObjective}
                  onSelect={setSelected}
                />
              ) : (
                <DependencyGraph
                  objectives={shown}
                  rel={rel}
                  selected={selected}
                  onSelect={setSelected}
                />
              )}
            </main>

            {current && (
              <IssueRefContext.Provider value={issueRefs}>
                <ObjectiveDetail
                  key={current.id}
                  objective={current}
                  all={objectives}
                  rel={rel.get(current.id)!}
                  sessions={sessions}
                  issues={byObjective.get(current.id) ?? NO_ISSUES}
                  onSelect={setSelected}
                  onClose={() => setSelected(null)}
                  onOpenSession={onOpenSession}
                  onOpenIssue={(id) => issueRefs?.open(id)}
                  onAskLead={onAskLead}
                />
              </IssueRefContext.Provider>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function ObjectiveList({
  objectives,
  rel,
  grouped,
  selected,
  sessions,
  issues,
  onSelect,
}: {
  objectives: Objective[];
  rel: Map<string, Relations>;
  grouped: boolean;
  selected: string | null;
  sessions: Map<string, SessionInfo>;
  issues: Map<string, IssueEntry[]>;
  onSelect: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => reveal(boxRef.current, selected), [selected]);
  const groups = grouped
    ? [...new Set(objectives.map((o) => o.area))]
        .sort()
        .map((area) => ({ area, items: objectives.filter((o) => o.area === area) }))
    : [{ area: null, items: objectives }];
  return (
    <div ref={boxRef}>
      {groups.map((g) => (
        <section key={g.area ?? ""} className="bp-group">
          {g.area && <h3 className="bp-group-title">{g.area}</h3>}
          <div className="bp-cards">
            {g.items.map((o) => (
              <ObjectiveCard
                key={o.id}
                objective={o}
                rel={rel.get(o.id)!}
                selected={o.id === selected}
                sessions={sessions}
                openIssues={issues.get(o.id)?.filter(isOpen).length ?? 0}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ObjectiveCard({
  objective: o,
  rel,
  selected,
  sessions,
  openIssues,
  onSelect,
}: {
  objective: Objective;
  rel: Relations;
  selected: boolean;
  sessions: Map<string, SessionInfo>;
  openIssues: number;
  onSelect: (id: string) => void;
}) {
  const { done, total } = progress(o);
  const toDecide = openDecisions(o);
  const st = o.archived ? null : stage(o, rel);
  const live = o.sessions.filter((s) => sessions.get(s)?.state === "working");
  return (
    <button
      data-objective={o.id}
      className={`bp-card prio-${o.priority} st-${o.status}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(o.id)}
    >
      <span className="bp-card-top">
        <span className="bp-id">{o.id}</span>
        {o.priority !== "normal" && (
          <span className={`bp-prio prio-${o.priority}`}>{o.priority}</span>
        )}
        {o.status !== "active" && (
          <span className={`bp-pill st-${o.status}`}>{STATUS_LABEL[o.status]}</span>
        )}
      </span>
      <span className="bp-card-title">
        <InlineMd>{o.title}</InlineMd>
      </span>
      <span className="bp-card-goal">
        <InlineMd>{o.goal}</InlineMd>
      </span>
      {o.reason && o.status !== "active" && <span className="bp-card-reason">{o.reason}</span>}
      <span className="bp-card-foot">
        {total > 0 && (
          <span className="bp-progress" title={`${done} of ${total} tasks done`}>
            <span className="bp-bar">
              <span style={{ width: `${(done / total) * 100}%` }} />
            </span>
            {done}/{total}
          </span>
        )}
        {toDecide > 0 && !o.archived && <span className="bp-decide">{toDecide} to decide</span>}
        {openIssues > 0 && !o.archived && (
          <span className="bi-count">
            {openIssues} issue{openIssues === 1 ? "" : "s"}
          </span>
        )}
        {st && (
          <span className={`bp-stage stage-${st.replace(" ", "-")}`}>
            {st === "blocked" ? `blocked by ${rel.blockedBy.length}` : st}
          </span>
        )}
        {o.archived && <span className="bp-updated">archived {formatRelative(o.updatedAt)}</span>}
        {live.length > 0 && (
          <span className="bp-live" title={live.map((s) => sessions.get(s)!.name).join(", ")}>
            <span className="streaming-dot" /> {live.length}
          </span>
        )}
      </span>
    </button>
  );
}

type Edge = { from: string; to: string; d: string };

// Columns left to right by depth of prerequisites, rows ordered to keep
// connected objectives close; edges from each prerequisite to what needs
// it. Selecting or hovering an objective lights up everything it waits on
// and everything waiting on it; those edges are drawn over the nodes.
function DependencyGraph({
  objectives,
  rel,
  selected,
  onSelect,
}: {
  objectives: Objective[];
  rel: Map<string, Relations>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { columns, independent } = useMemo(() => layout(objectives), [objectives]);
  const shownIds = useMemo(() => new Set(objectives.map((o) => o.id)), [objectives]);
  const [focus, setFocus] = useState<string | null>(null);
  const candidate = focus ?? selected;
  const lit = candidate && shownIds.has(candidate) ? candidate : null;
  const up = useMemo(() => (lit ? reach(objectives, lit, "up") : null), [objectives, lit]);
  const down = useMemo(() => (lit ? reach(objectives, lit, "down") : null), [objectives, lit]);
  const boxRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box) return;
      const origin = box.getBoundingClientRect();
      const at = (id: string) => nodes.current.get(id)?.getBoundingClientRect();
      const next: Edge[] = [];
      for (const o of objectives) {
        for (const dep of o.dependsOn) {
          if (!shownIds.has(dep)) continue;
          const a = at(dep);
          const b = at(o.id);
          if (!a || !b) continue;
          const x1 = a.right - origin.left;
          const y1 = a.top + a.height / 2 - origin.top;
          const x2 = b.left - origin.left;
          const y2 = b.top + b.height / 2 - origin.top;
          const bend = Math.max(24, (x2 - x1) / 2);
          next.push({
            from: dep,
            to: o.id,
            d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
          });
        }
      }
      setEdges(next);
      setSize({ w: box.scrollWidth, h: box.scrollHeight });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (boxRef.current) observer?.observe(boxRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [objectives, columns, independent, shownIds]);

  useEffect(() => reveal(boxRef.current, selected), [selected]);

  // An edge on the chain of prerequisites of the lit objective, or on the
  // chain of what waits on it.
  const edgeClass = (e: { from: string; to: string }) => {
    if (!lit) return "";
    if (up?.has(e.from) && (e.to === lit || up.has(e.to))) return "up";
    if (down?.has(e.to) && (e.from === lit || down.has(e.from))) return "down";
    return "dim";
  };
  const nodeClass = (id: string) => {
    if (!lit) return "";
    if (id === lit) return " lit";
    if (up?.has(id)) return " up";
    if (down?.has(id)) return " down";
    return " dim";
  };
  const node = (o: Objective) => {
    const st = stage(o, rel.get(o.id)!);
    const hidden = o.dependsOn.filter((d) => !shownIds.has(d));
    return (
      <button
        key={o.id}
        data-objective={o.id}
        ref={(el) => {
          if (el) nodes.current.set(o.id, el);
          else nodes.current.delete(o.id);
        }}
        className={`bp-node prio-${o.priority} st-${o.status}${nodeClass(o.id)}${o.id === selected ? " selected" : ""}`}
        onClick={() => onSelect(o.id)}
        // A tap raises pointer enter but never leave: hover is for mice.
        onPointerEnter={(e) => e.pointerType === "mouse" && setFocus(o.id)}
        onPointerLeave={(e) => e.pointerType === "mouse" && setFocus(null)}
      >
        <span className="bp-node-title">
          <InlineMd>{o.title}</InlineMd>
        </span>
        <span className="bp-node-meta">
          {o.id}
          {st && <span className={`bp-stage stage-${st.replace(" ", "-")}`}>{st}</span>}
          {o.status !== "active" && (
            <span className={`bp-pill st-${o.status}`}>{STATUS_LABEL[o.status]}</span>
          )}
          {hidden.length > 0 && (
            <span className="bp-hidden" title={`Not shown: ${hidden.join(", ")}`}>
              +{hidden.length} not shown
            </span>
          )}
        </span>
      </button>
    );
  };
  const lines = (layer: "under" | "over") => (
    <svg className={`bp-edges ${layer}`} width={size.w} height={size.h} aria-hidden="true">
      {edges
        .filter((e) => (layer === "over") === ["up", "down"].includes(edgeClass(e)))
        .map((e) => (
          <path key={`${e.from}>${e.to}`} className={edgeClass(e)} d={e.d} />
        ))}
    </svg>
  );

  return (
    <div className="bp-graph" ref={boxRef}>
      {lines("under")}
      {columns.map((col, i) => (
        <div key={i} className="bp-column">
          <div className="bp-column-title">Step {i + 1}</div>
          {col.map(node)}
        </div>
      ))}
      {independent.length > 0 && (
        <div className="bp-column bp-independent">
          <div className="bp-column-title">Independent</div>
          {independent.map(node)}
        </div>
      )}
      {lines("over")}
    </div>
  );
}

function ObjectiveDetail({
  objective: o,
  all,
  rel,
  sessions,
  issues,
  onSelect,
  onClose,
  onOpenSession,
  onOpenIssue,
  onAskLead,
}: {
  objective: Objective;
  all: Objective[];
  rel: Relations;
  sessions: Map<string, SessionInfo>;
  // Linked to it, by the issue, its group or its module.
  issues: IssueEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSession: (workspaceId: string) => void;
  onOpenIssue: (id: string) => void;
  onAskLead: ((objectiveId: string) => void) | null;
}) {
  const self = useRef<HTMLElement>(null);
  // Opened from one of its own links, the details replace the button that
  // had focus: the keyboard goes on from the new details, not the page.
  useEffect(() => {
    if (document.activeElement === document.body) self.current?.focus({ preventScroll: true });
  }, []);
  const byId = new Map(all.map((x) => [x.id, x]));
  const { done, total } = progress(o);
  const open = o.decisions.filter((d) => !d.outcome);
  const settled = o.decisions.filter((d) => d.outcome);
  const ref = (id: string) => {
    const target = byId.get(id);
    if (!target) {
      return (
        <span key={id} className="bp-ref missing" title="Not an objective">
          <span className="clip">{id}</span>
        </span>
      );
    }
    const note = target.archived ? " (archived)" : "";
    return (
      <button
        key={id}
        className={`bp-ref st-${target.status}${rel.blockedBy.includes(id) ? " blocking" : ""}`}
        onClick={() => onSelect(id)}
        title={`${STATUS_LABEL[target.status]}${note}: ${target.goal}`}
      >
        {/* A button holds no issue links of its own. */}
        <IssueRefContext.Provider value={null}>
          <span className="clip">
            <InlineMd>{target.title}</InlineMd>
          </span>
        </IssueRefContext.Provider>
      </button>
    );
  };
  const openIssues = issues.filter(isOpen);
  const accepted = issues.length - openIssues.length;
  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) return null;
    return (
      <button
        key={id}
        className={`bp-session ss-${s.state}`}
        title={s.name}
        onClick={() => onOpenSession(id)}
      >
        <span className="bp-session-dot" />
        <span className="clip">{s.name}</span>
      </button>
    );
  };

  return (
    <aside ref={self} tabIndex={-1} className="bp-detail" aria-label={o.title}>
      <div className="bp-detail-head">
        <button className="bp-back" aria-label="Back" onClick={onClose}>
          ‹
        </button>
        <span className="bp-id">{o.id}</span>
        {onAskLead && (
          <button className="bp-ask" onClick={() => onAskLead(o.id)}>
            Ask the lead
          </button>
        )}
        <button
          className="side-panel-btn bp-close bp-detail-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 className="bp-detail-title">
        <InlineMd>{o.title}</InlineMd>
      </h2>
      <div className="bp-meta">
        <span className={`bp-pill st-${o.status}`}>{STATUS_LABEL[o.status]}</span>
        {o.archived && <span className="bp-pill">Archived</span>}
        <span className={`bp-prio prio-${o.priority}`}>{o.priority} priority</span>
        <span className="bp-updated">updated {formatRelative(o.updatedAt)}</span>
      </div>
      {o.reason && (
        <p className="bp-reason">
          <InlineMd>{o.reason}</InlineMd>
        </p>
      )}

      <DetailSection title="Goal">
        <p className="bp-goal">
          <InlineMd>{o.goal}</InlineMd>
        </p>
      </DetailSection>

      <DetailSection title="Depends on">
        {o.dependsOn.length ? (
          <div className="bp-refs">{o.dependsOn.map(ref)}</div>
        ) : (
          <p className="bp-none">Nothing: it can start any time.</p>
        )}
      </DetailSection>
      {rel.unblocks.length > 0 && (
        <DetailSection title="Needed by">
          <div className="bp-refs">{rel.unblocks.map(ref)}</div>
        </DetailSection>
      )}

      {o.context && (
        <DetailSection title="Where it stands">
          <div className="message-content bp-md">
            <MdBlock>{o.context}</MdBlock>
          </div>
        </DetailSection>
      )}

      <DetailSection title={total ? `Tasks · ${done}/${total}` : "Tasks"}>
        {o.tasks.length ? (
          <ul className="bp-tasks">
            {o.tasks.map((t) => (
              <li key={t.id} className={`task-${t.state}`}>
                <span className="bp-task-mark" title={t.state}>
                  {TASK_MARK[t.state]}
                </span>
                <span className="bp-task-text">
                  <InlineMd>{t.text}</InlineMd>
                </span>
                {t.session && session(t.session)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="bp-none">No tasks yet.</p>
        )}
      </DetailSection>

      {open.length > 0 && (
        <DetailSection title={`To decide · ${open.length}`}>
          <ul className="bp-decisions open">
            {open.map((d) => (
              <li key={d.id}>
                <InlineMd>{d.question}</InlineMd>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      {settled.length > 0 && (
        <DetailSection title="Settled">
          <ul className="bp-decisions">
            {settled.map((d) => (
              <li key={d.id}>
                <span className="bp-question">
                  <InlineMd>{d.question}</InlineMd>
                </span>
                <span className="bp-outcome">
                  <InlineMd>{d.outcome ?? ""}</InlineMd>
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {issues.length > 0 && (
        <DetailSection title={`Issues · ${openIssues.length} open`}>
          {openIssues.length > 0 && (
            <ul className="bi-linked">
              {openIssues.map((e) => (
                <li key={e.issue.id}>
                  <button
                    className={`bi-ref is-${e.issue.state}`}
                    onClick={() => onOpenIssue(e.issue.id)}
                  >
                    <span className="bp-id">{e.issue.id}</span>
                    <IssueRefContext.Provider value={null}>
                      <span className="bi-ref-text">
                        <InlineMd>{issueSummary(e.issue.text)}</InlineMd>
                      </span>
                    </IssueRefContext.Provider>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {accepted > 0 && <p className="bp-none">{accepted} accepted, not to be fixed.</p>}
        </DetailSection>
      )}

      {o.sessions.some((s) => sessions.has(s)) && (
        <DetailSection title="Sessions">
          <div className="bp-refs">{o.sessions.map(session)}</div>
        </DetailSection>
      )}
      {o.notes && (
        <DetailSection title="Notes">
          <div className="message-content bp-md">
            <MdBlock>{o.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
    </aside>
  );
}

function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  if (!editing) {
    return (
      <button className="bp-name" title="Rename" onClick={() => setEditing(true)}>
        {name}
      </button>
    );
  }
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() && value.trim() !== name) onRename(value.trim());
  };
  return (
    <input
      className="bp-name-input"
      aria-label="Project name"
      autoFocus
      defaultValue={name}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        compositionEnd.current = e.timeStamp;
      }}
      onKeyDown={(e) => {
        if (isImeKeyEvent(e, composing.current, compositionEnd.current)) return;
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          setEditing(false);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}
