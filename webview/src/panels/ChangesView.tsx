import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { highlightTree } from "../chat/highlight";
import { FileIcon } from "./Icon";
import { textOffset, useSelectedLines, type PickedLines } from "./selection";

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

export interface ChangeDir {
  name: string;
  path: string;
  dirs: ChangeDir[];
  files: ChangedFile[];
}

// A changed path's last part: a nested repository git lists as "wt/feat/"
// keeps its slash.
function changeName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) + (trimmed === path ? "" : "/");
}

// The changed files as folders, folders first and each level by name; a
// folder holding nothing but one folder shows as one row ("src/sched"), as
// VS Code shows it.
export function changeTree(files: ChangedFile[]): ChangeDir {
  const root: ChangeDir = { name: "", path: "", dirs: [], files: [] };
  for (const f of files) {
    let dir = root;
    for (const name of f.path.replace(/\/+$/, "").split("/").slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${name}` : name;
      let next = dir.dirs.find((d) => d.name === name);
      if (!next) dir.dirs.push((next = { name, path, dirs: [], files: [] }));
      dir = next;
    }
    dir.files.push(f);
  }
  const tidy = (d: ChangeDir): ChangeDir => {
    let dir = d;
    while (dir !== root && dir.files.length === 0 && dir.dirs.length === 1) {
      const only = dir.dirs[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return {
      ...dir,
      dirs: dir.dirs.map(tidy).sort((a, b) => a.name.localeCompare(b.name)),
      files: [...dir.files].sort((a, b) => changeName(a.path).localeCompare(changeName(b.path))),
    };
  };
  return tidy(root);
}

function Count({ added, removed }: { added: number | null; removed: number | null }) {
  return (
    <span className="change-count">
      {added === null ? (
        "binary"
      ) : (
        <>
          {added > 0 && <span className="diff-plus">+{added}</span>}{" "}
          {removed! > 0 && <span className="diff-minus">−{removed}</span>}
        </>
      )}
    </span>
  );
}

// `closed`: the folders folded, kept by the panel while a diff is open.
export function ChangesList({
  changes,
  open,
  closed,
  toggle,
}: {
  changes: Changes;
  open: (f: ChangedFile) => void;
  closed: ReadonlySet<string>;
  toggle: (folder: string) => void;
}) {
  const added = changes.files.reduce((s, f) => s + (f.added ?? 0), 0);
  const removed = changes.files.reduce((s, f) => s + (f.removed ?? 0), 0);
  const n = changes.files.length;
  const tree = useMemo(() => changeTree(changes.files), [changes.files]);
  const rows: ReactNode[] = [];
  const walk = (dir: ChangeDir, depth: number) => {
    for (const d of dir.dirs) {
      const shut = closed.has(d.path);
      rows.push(
        <button
          key={`d:${d.path}`}
          className="dir-entry change-folder"
          style={{ "--depth": depth } as CSSProperties}
          title={d.path}
          aria-expanded={!shut}
          onClick={() => toggle(d.path)}
        >
          <span className={`bn-caret${shut ? "" : " open"}`} aria-hidden="true">
            ›
          </span>
          <FileIcon name={d.name.slice(d.name.lastIndexOf("/") + 1)} dir />
          <span className="dir-entry-name">{d.name}</span>
        </button>,
      );
      if (!shut) walk(d, depth + 1);
    }
    for (const f of dir.files) {
      rows.push(
        <button
          key={f.path}
          className="dir-entry change-entry"
          style={{ "--depth": depth } as CSSProperties}
          title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          onClick={() => open(f)}
        >
          <span className={`change-status cs-${f.status}`} title={f.status}>
            {LETTER[f.status]}
          </span>
          <FileIcon name={changeName(f.path).replace(/\/$/, "")} dir={f.path.endsWith("/")} />
          <span className="dir-entry-name">{changeName(f.path)}</span>
          <Count added={f.added} removed={f.removed} />
        </button>,
      );
    }
  };
  walk(tree, 0);
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
            {added > 0 && <span className="diff-plus">+{added}</span>}{" "}
            {removed > 0 && <span className="diff-minus">−{removed}</span>}
          </>
        )}
      </div>
      {rows}
      {n === 0 && <div className="file-note">No changes</div>}
      {changes.truncated && <div className="file-note">Only the first files are listed.</div>}
    </div>
  );
}

// Rows of a diff picked out to ask about: as a diff, numbered by the new
// side (the old one when they only remove).
export function pickRows(rows: DiffRow[]): PickedLines | null {
  const lines = rows.filter((r) => r.kind !== "note");
  const side = lines.some((r) => r.new !== undefined) ? "new" : "old";
  const numbers = lines.flatMap((r) => r[side] ?? []);
  if (numbers.length === 0) return null;
  const sign: Record<DiffRow["kind"], string> = {
    add: "+",
    del: "-",
    context: " ",
    hunk: "",
    note: "",
  };
  return {
    from: numbers[0],
    to: numbers.at(-1)!,
    text: lines.map((r) => `${sign[r.kind]}${r.text}`).join("\n"),
  };
}

function highlighted(lang: string, text: string): ReactNode {
  const tree = highlightTree(lang, text);
  // Its typings name the global JSX namespace React 19 no longer has.
  return tree ? (toJsxRuntime(tree, { Fragment, jsx, jsxs }) as ReactNode) : text;
}

// A file's diff, line by line with both line numbers, never wrapped: a line
// wider than the panel scrolls sideways, the numbers stay in view.
export function DiffView({
  diff,
  lang,
  onPick,
}: {
  diff: FileDiff;
  lang: string | null;
  onPick?: (lines: PickedLines | null) => void;
}) {
  const rows = useMemo(() => parseDiff(diff.diff), [diff.diff]);
  const inner = useRef<HTMLDivElement>(null);
  const read = useCallback(
    (range: Range) => {
      const el = inner.current;
      if (!el) return null;
      const rowAt = (end: "start" | "end") => {
        const node = end === "start" ? range.startContainer : range.endContainer;
        const row = (node instanceof Element ? node : node.parentElement)?.closest(".diff-row");
        if (row && el.contains(row)) return Number((row as HTMLElement).dataset.row);
        return textOffset(el, range, end) === 0 ? 0 : rows.length - 1;
      };
      let first = rowAt("start");
      let last = rowAt("end");
      // Starting at the very end of a row's code, or ending at the very start
      // of it (the gutter's numbers are not part of the selection), leaves
      // that row out.
      const code = (i: number) => el.children[i].querySelector(".diff-code") ?? el.children[i];
      const width = code(first).textContent?.length ?? 0;
      if (last > first && width > 0 && textOffset(code(first), range, "start") === width) first++;
      if (last > first && textOffset(code(last), range, "end") === 0) last--;
      return pickRows(rows.slice(first, last + 1));
    },
    [rows],
  );
  useSelectedLines(inner, read, onPick);
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
      <div
        className="diff-inner hljs"
        ref={inner}
        style={{ "--diff-digits": `${digits}ch` } as CSSProperties}
      >
        {rows.map((r, i) =>
          r.kind === "hunk" || r.kind === "note" ? (
            <div key={i} className={`diff-row diff-${r.kind}`} data-row={i}>
              <span className="diff-gutter" />
              <span className="diff-code">{r.text}</span>
            </div>
          ) : (
            <div key={i} className={`diff-row diff-${r.kind}`} data-row={i}>
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
