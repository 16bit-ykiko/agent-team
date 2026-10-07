import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Evidence, IssueModule, IssueState, Objective } from "../state/useServer";
import { InlineMd, IssueRefContext, MdBlock } from "../chat/markdown";
import { Icon } from "../panels/Icon";
import {
  issueMatches,
  issueSummary,
  linkedObjectives,
  moduleCounts,
  tagCounts,
  type IssueEntry,
  type IssueFilter,
} from "./issues";

// The project's issues on the board page: modules and filters on the left,
// the issues by module and group in the middle, the selected one in full on
// the right. Read-only, like the objectives.

export const ISSUE_STATES: IssueState[] = ["open", "decision", "accepted"];
export const ISSUE_STATE_LABEL: Record<IssueState, string> = {
  open: "Open",
  decision: "To decide",
  accepted: "Accepted",
};
const EVIDENCE: Evidence[] = ["R", "V", "H", "S", "C"];
const EVIDENCE_LABEL: Record<Evidence, string> = {
  R: "Reproduced by a script",
  V: "Confirmed by a probe",
  H: "Read from the code only",
  S: "Still there on an earlier re-test",
  C: "Another agent's probe, not checked here",
};

// A module's title up to its parenthesised scope: "Hosting (hosting.cpp)".
function shortTitle(m: IssueModule): string {
  return m.title.split(/\s*[（(]/)[0] || m.title;
}

function toggle<T>(list: T[], x: T): T[] {
  return list.includes(x) ? list.filter((y) => y !== x) : [...list, x];
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bp-section">
      <h4 className="bp-section-title">{title}</h4>
      {children}
    </section>
  );
}

export function IssueNav({
  modules,
  entries,
  filter,
  onFilter,
}: {
  modules: IssueModule[];
  entries: IssueEntry[];
  filter: IssueFilter;
  onFilter: (f: IssueFilter) => void;
}) {
  // Each number is the rows the filter it stands on gives with the others.
  const count = (f: IssueFilter) => entries.filter((e) => issueMatches(e, f)).length;
  const inView = count({ ...filter, module: null });
  const tags = tagCounts(entries, filter);
  return (
    <nav className="bp-nav" aria-label="Issue filters">
      <div className="bp-areas">
        <button
          className={`bp-area${filter.module === null ? " active" : ""}`}
          onClick={() => onFilter({ ...filter, module: null })}
        >
          <span className="bp-area-name">All modules</span>
          <span className="bp-count">{inView}</span>
        </button>
        {moduleCounts(modules, entries, filter).map(({ module: m, count: n }) => (
          <button
            key={m.id}
            className={`bp-area${filter.module === m.id ? " active" : ""}${n ? "" : " empty"}`}
            title={`${m.id}: ${m.title}`}
            onClick={() => onFilter({ ...filter, module: m.id })}
          >
            <span className="bp-area-name">{shortTitle(m)}</span>
            <span className="bp-count">{n}</span>
          </button>
        ))}
      </div>
      <div className="bp-statuses" role="group" aria-label="State">
        {ISSUE_STATES.map((s) => (
          <button
            key={s}
            className={`bp-status-toggle is-${s}`}
            aria-pressed={filter.states.includes(s)}
            onClick={() => onFilter({ ...filter, states: toggle(filter.states, s) })}
          >
            {ISSUE_STATE_LABEL[s]}{" "}
            <span className="bp-count">{count({ ...filter, states: [s] })}</span>
          </button>
        ))}
      </div>
      <div className="bi-chips" role="group" aria-label="Evidence">
        {EVIDENCE.map((ev) => (
          <button
            key={ev}
            className={`bi-chip bi-evidence ev-${ev}`}
            title={EVIDENCE_LABEL[ev]}
            aria-pressed={filter.evidence.includes(ev)}
            onClick={() => onFilter({ ...filter, evidence: toggle(filter.evidence, ev) })}
          >
            {ev} <span className="bp-count">{count({ ...filter, evidence: [ev] })}</span>
          </button>
        ))}
      </div>
      {tags.length > 0 && (
        <div className="bi-chips" role="group" aria-label="Tags">
          {tags.map(({ tag, count: n }) => (
            <button
              key={tag}
              className="bi-chip"
              aria-pressed={filter.tags.includes(tag)}
              onClick={() => onFilter({ ...filter, tags: toggle(filter.tags, tag) })}
            >
              {tag} <span className="bp-count">{n}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

export function IssueList({
  shown,
  grouped,
  selected,
  onSelect,
}: {
  shown: IssueEntry[];
  // All modules: each under its title.
  grouped: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const el = [...(boxRef.current?.querySelectorAll<HTMLElement>("[data-issue]") ?? [])].find(
      (e) => e.dataset.issue === selected,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const modules = [...new Set(shown.map((e) => e.module))];
  return (
    <div ref={boxRef}>
      {modules.map((m) => {
        const mine = shown.filter((e) => e.module === m);
        const groups = [...new Set(mine.map((e) => e.group))];
        return (
          <section key={m.id} className="bp-group">
            {grouped && (
              <h3 className="bp-group-title bi-module-title" title={m.id}>
                {m.title}
              </h3>
            )}
            {m.notes && (
              <p className="bi-group-notes bi-module-notes">
                <InlineMd>{issueSummary(m.notes)}</InlineMd>
              </p>
            )}
            {groups.map((g) => (
              <div key={g?.id ?? ""} className="bi-group">
                {g && (
                  <div className="bi-group-head">
                    <h4 className="bi-group-title">{g.title}</h4>
                    {g.notes && (
                      <p className="bi-group-notes">
                        <InlineMd>{issueSummary(g.notes)}</InlineMd>
                      </p>
                    )}
                  </div>
                )}
                <div className="bi-rows">
                  {mine
                    .filter((e) => e.group === g)
                    .map((e) => (
                      <IssueRow
                        key={e.issue.id}
                        entry={e}
                        selected={e.issue.id === selected}
                        onSelect={onSelect}
                      />
                    ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function IssueRow({
  entry: { issue: x },
  selected,
  onSelect,
}: {
  entry: IssueEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      data-issue={x.id}
      className={`bi-row is-${x.state}${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(x.id)}
    >
      <span className="bi-row-top">
        <span className="bp-id">{x.id}</span>
        {x.evidence && (
          <span className={`bi-evidence ev-${x.evidence}`} title={EVIDENCE_LABEL[x.evidence]}>
            {x.evidence}
          </span>
        )}
        {x.state !== "open" && (
          <span className={`bp-pill is-${x.state}`}>{ISSUE_STATE_LABEL[x.state]}</span>
        )}
        {x.tags.map((t) => (
          <span key={t} className="bi-tag">
            {t}
          </span>
        ))}
      </span>
      <span className="bi-row-text">
        <InlineMd>{issueSummary(x.text)}</InlineMd>
      </span>
    </button>
  );
}

export function IssueDetail({
  entry: e,
  objectives,
  onSelectObjective,
  onClose,
}: {
  entry: IssueEntry;
  objectives: Objective[];
  onSelectObjective: (id: string) => void;
  onClose: () => void;
}) {
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) self.current?.focus({ preventScroll: true });
  }, []);
  const x = e.issue;
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const linked = linkedObjectives(e);
  return (
    <aside ref={self} tabIndex={-1} className="bp-detail" aria-label={`Issue ${x.id}`}>
      <div className="bp-detail-head">
        <button className="bp-back" aria-label="Back" onClick={onClose}>
          ‹
        </button>
        <span className="bp-id">{x.id}</span>
        <button
          className="side-panel-btn bp-close bp-detail-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="bp-meta">
        <span className={`bp-pill is-${x.state}`}>{ISSUE_STATE_LABEL[x.state]}</span>
        {x.evidence && (
          <span className={`bi-evidence ev-${x.evidence}`}>
            {x.evidence} · {EVIDENCE_LABEL[x.evidence]}
          </span>
        )}
        {x.tags.map((t) => (
          <span key={t} className="bi-tag">
            {t}
          </span>
        ))}
      </div>
      <p className="bi-where" title={e.module.id}>
        {e.module.title}
        {e.group && <> › {e.group.title}</>}
      </p>
      <div className="message-content bp-md">
        <MdBlock>{x.text}</MdBlock>
      </div>
      {e.group?.notes && (
        <DetailSection title="In common with its group">
          <div className="message-content bp-md">
            <MdBlock>{e.group.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
      {e.module.notes && (
        <DetailSection title="About the module">
          <div className="message-content bp-md">
            <MdBlock>{e.module.notes}</MdBlock>
          </div>
        </DetailSection>
      )}
      <DetailSection title="Objectives">
        {linked.length ? (
          <div className="bp-refs">
            {linked.map((id) => {
              const o = byId.get(id);
              return o ? (
                <button
                  key={id}
                  className={`bp-ref st-${o.status}`}
                  title={o.goal}
                  onClick={() => onSelectObjective(id)}
                >
                  {/* A button holds no issue links of its own. */}
                  <IssueRefContext.Provider value={null}>
                    <span className="clip">
                      <InlineMd>{o.title}</InlineMd>
                    </span>
                  </IssueRefContext.Provider>
                </button>
              ) : (
                <span key={id} className="bp-ref missing" title="Not an objective">
                  <span className="clip">{id}</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="bp-none">No objective works on it yet.</p>
        )}
      </DetailSection>
    </aside>
  );
}
