import { useMemo, type CSSProperties, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { highlightTree } from "../chat/highlight";
import { FileIcon } from "./Icon";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  added: number | null;
  removed: number | null;
}

// A branch's changes against its base (service/src/repo/diff.ts).
export interface Changes {
  top: string;
  branch: string | null;
  base: string | null;
  against: string;
  files: ChangedFile[];
  truncated: boolean;
}

export interface FileDiff {
  path: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
}

export interface DiffRow {
  kind: "hunk" | "context" | "add" | "del" | "note";
  old?: number;
  new?: number;
  text: string;
}

const LETTER: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

// Past this many rows a diff is shown plain: highlighting blocks the page.
const HIGHLIGHT_ROWS = 4000;

// A unified diff's rows, each with its line numbers on the old and the new
// side.
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", new: n++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: o++, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2) });
    else if (line.startsWith(" ")) {
      rows.push({ kind: "context", old: o++, new: n++, text: line.slice(1) });
    }
  }
  return rows;
}

export function ChangesList({
  changes,
  open,
}: {
  changes: Changes;
  open: (f: ChangedFile) => void;
}) {
  const added = changes.files.reduce((s, f) => s + (f.added ?? 0), 0);
  const removed = changes.files.reduce((s, f) => s + (f.removed ?? 0), 0);
  const n = changes.files.length;
  return (
    <div className="dir-view changes">
      <div className="changes-head">
        {changes.base ? (
          <>
            against <span className="changes-base">{changes.base}</span>
          </>
        ) : (
          "not committed"
        )}
        {" · "}
        {n} {n === 1 ? "file" : "files"}
        {n > 0 && (
          <>
            {" · "}
            <span className="diff-plus">+{added}</span>{" "}
            <span className="diff-minus">−{removed}</span>
          </>
        )}
      </div>
      {changes.files.map((f) => {
        const cut = f.path.lastIndexOf("/");
        return (
          <button
            key={f.path}
            className="dir-entry change-entry"
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            onClick={() => open(f)}
          >
            <span className={`change-status cs-${f.status}`} title={f.status}>
              {LETTER[f.status]}
            </span>
            <FileIcon name={f.path} />
            <span className="dir-entry-name">
              {cut >= 0 && <span className="change-dir">{f.path.slice(0, cut + 1)}</span>}
              {f.path.slice(cut + 1)}
            </span>
            <span className="change-count">
              {f.added === null ? (
                "binary"
              ) : (
                <>
                  {f.added > 0 && <span className="diff-plus">+{f.added}</span>}{" "}
                  {f.removed! > 0 && <span className="diff-minus">−{f.removed}</span>}
                </>
              )}
            </span>
          </button>
        );
      })}
      {n === 0 && <div className="file-note">No changes</div>}
      {changes.truncated && <div className="file-note">Only the first files are listed.</div>}
    </div>
  );
}

function highlighted(lang: string, text: string): ReactNode {
  const tree = highlightTree(lang, text);
  // Its typings name the global JSX namespace React 19 no longer has.
  return tree ? (toJsxRuntime(tree, { Fragment, jsx, jsxs }) as ReactNode) : text;
}

// A file's diff, line by line with both line numbers, never wrapped: a line
// wider than the panel scrolls sideways, the numbers stay in view.
export function DiffView({ diff, lang }: { diff: FileDiff; lang: string | null }) {
  const rows = useMemo(() => parseDiff(diff.diff), [diff.diff]);
  const light = lang && rows.length <= HIGHLIGHT_ROWS ? lang : null;
  const code = useMemo(
    () => rows.map((r) => (light && r.kind !== "hunk" ? highlighted(light, r.text) : r.text)),
    [rows, light],
  );
  // The number columns as wide as the largest number.
  const digits = String(rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0)).length;
  if (diff.binary) return <div className="file-note">Binary file changed</div>;
  if (rows.length === 0) return <div className="file-note">No changes in its text</div>;
  return (
    <div className="diff-view">
      <div className="diff-inner hljs" style={{ "--diff-digits": `${digits}ch` } as CSSProperties}>
        {rows.map((r, i) =>
          r.kind === "hunk" || r.kind === "note" ? (
            <div key={i} className={`diff-row diff-${r.kind}`}>
              <span className="diff-gutter" />
              <span className="diff-code">{r.text}</span>
            </div>
          ) : (
            <div key={i} className={`diff-row diff-${r.kind}`}>
              <span className="diff-gutter">
                <span className="diff-num">{r.old ?? ""}</span>
                <span className="diff-num">{r.new ?? ""}</span>
                <span className="diff-sign">
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                </span>
              </span>
              <span className="diff-code">{code[i]}</span>
            </div>
          ),
        )}
      </div>
      {diff.truncated && <div className="file-note">Only the first part of the diff is shown.</div>}
    </div>
  );
}
