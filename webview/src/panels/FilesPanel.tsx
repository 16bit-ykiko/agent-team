import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { highlightTree } from "../chat/highlight";
import { MdBlock } from "../chat/markdown";
import { FileOpenContext, parseFileRef, type FileRef } from "../chat/fileRef";
import { formatSize } from "../format";
import { FileIcon, Icon } from "./Icon";
import {
  ChangesList,
  DiffView,
  type ChangedFile,
  type Changes,
  type FileDiff,
} from "./ChangesView";

interface DirEntry {
  name: string;
  dir: boolean;
  size: number;
}

export type FileView =
  | { kind: "dir"; path: string; entries: DirEntry[]; truncated: boolean }
  | { kind: "text"; path: string; size: number; content: string; truncated: boolean }
  | { kind: "image" | "binary"; path: string; size: number };

type Load = { loading: true } | { error: string; path?: string } | { view: FileView };
type Fetched<T> = { loading: true } | { error: string } | { value: T };

function fetchJson<T>(url: string, done: (r: Fetched<T>) => void): () => void {
  let cancelled = false;
  done({ loading: true });
  fetch(url)
    .then(async (res) => {
      const body = (await res.json()) as T & { error?: string };
      if (!cancelled) done(res.ok ? { value: body } : { error: body.error ?? res.statusText });
    })
    .catch((e: unknown) => {
      if (!cancelled) done({ error: e instanceof Error ? e.message : String(e) });
    });
  return () => {
    cancelled = true;
  };
}

// Fixed so the line gutter, the code and the target-line band stay aligned.
const LINE_HEIGHT = 18;
// Highlighting a huge file blocks the main thread; beyond this it is plain.
const HIGHLIGHT_LIMIT = 300_000;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  md: "markdown",
  c: "c",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  cs: "csharp",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  if (/^(GNU)?makefile$/i.test(name)) return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? null;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  // Not yet resolved by the server (still loading, or failed).
  if (!trimmed.startsWith("/")) return trimmed === "." ? ".." : `${trimmed}/..`;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

// Within a root, the path from it: after the root picker, or after the
// root's own name when there is no picker.
function shownPath(path: string, root: FileRoot | undefined, picker: boolean): string {
  if (!root) return path;
  const rest = path.slice(root.path.length).replace(/^\//, "");
  if (picker) return rest || "/";
  const name = root.path.split("/").filter(Boolean).pop() ?? root.path;
  return rest ? `${name}/${rest}` : name;
}

// A reference found inside a previewed file, relative to that file's folder.
function resolveFrom(dir: string, ref: string): string {
  if (ref.startsWith("/") || ref.startsWith("~")) return ref;
  const parts = dir.split("/");
  for (const seg of ref.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/") || "/";
}

function CodeView({
  content,
  lang,
  target,
}: {
  content: string;
  lang: string | null;
  target: FileRef;
}) {
  const lines = useMemo(() => {
    const n = content.split("\n").length;
    return content.endsWith("\n") ? n - 1 : n;
  }, [content]);
  const body = useMemo((): ReactNode => {
    if (!lang || content.length > HIGHLIGHT_LIMIT) return content;
    const tree = highlightTree(lang, content);
    // Its typings name the global JSX namespace React 19 no longer has.
    return tree ? (toJsxRuntime(tree, { Fragment, jsx, jsxs }) as ReactNode) : content;
  }, [content, lang]);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (target.line && scroller.current) {
      scroller.current.scrollTop = Math.max(0, (target.line - 4) * LINE_HEIGHT);
    }
  }, [target.line, content]);
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  return (
    <div className="code-view" ref={scroller}>
      <div className="code-view-inner">
        {target.line && (
          <div
            className="code-mark"
            style={{
              top: (target.line - 1) * LINE_HEIGHT,
              height: ((target.endLine ?? target.line) - target.line + 1) * LINE_HEIGHT,
            }}
          />
        )}
        <div className="code-gutter" aria-hidden="true">
          {gutter}
        </div>
        <pre className="code-text hljs">
          <code>{body}</code>
        </pre>
      </div>
    </div>
  );
}

function DirView({
  view,
  open,
}: {
  view: Extract<FileView, { kind: "dir" }>;
  open: (p: string) => void;
}) {
  return (
    <div className="dir-view">
      {view.entries.map((e) => (
        <button
          key={e.name}
          className={`dir-entry${e.dir ? " is-dir" : ""}`}
          onClick={() => open(`${view.path}/${e.name}`)}
        >
          <FileIcon name={e.name} dir={e.dir} />
          <span className="dir-entry-name">
            {e.name}
            {e.dir && <span className="dir-slash">/</span>}
          </span>
          {!e.dir && <span className="dir-entry-size">{formatSize(e.size)}</span>}
        </button>
      ))}
      {view.entries.length === 0 && <div className="file-note">Empty folder</div>}
      {view.truncated && <div className="file-note">Only the first entries are listed.</div>}
    </div>
  );
}

// A folder to start browsing from: the workspace's, or for a project each
// session's (the repository and its worktrees).
export interface FileRoot {
  label: string;
  path: string;
}

// Read-only preview of a file or folder, in the Files panel: code with line
// numbers (jumping to the referenced line), rendered markdown, images,
// folder listings; and the branch's changes against its base, file by
// file. Relative paths resolve against `wsId`'s folder; the parent
// remounts it (a new key) for each file opened from the chat.
export function FilesPanel({
  wsId,
  target,
  roots,
}: {
  wsId: string;
  target: FileRef;
  roots: FileRoot[];
}) {
  const [ref, setRef] = useState(target);
  const [load, setLoad] = useState<Load>({ loading: true });
  // A line to show is a line of the source, not of the rendered page.
  const [source, setSource] = useState(!!target.line);
  const [copied, setCopied] = useState(false);
  // The branch's changes, and the one whose diff is shown.
  const [changesOn, setChangesOn] = useState(false);
  const [changes, setChanges] = useState<Fetched<Changes>>({ loading: true });
  const [changed, setChanged] = useState<ChangedFile | null>(null);
  const [diff, setDiff] = useState<Fetched<FileDiff>>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setLoad({ loading: true });
    const query = `ws=${encodeURIComponent(wsId)}&path=${encodeURIComponent(ref.path)}`;
    fetch(`api/file?${query}`)
      .then(async (res) => {
        const body = (await res.json()) as FileView & { error?: string };
        if (cancelled) return;
        setLoad(res.ok ? { view: body } : { error: body.error ?? res.statusText, path: body.path });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [wsId, ref.path]);

  const view = "view" in load ? load.view : null;
  const path = view?.path ?? ("path" in load && load.path ? load.path : ref.path);
  const raw = `api/file/raw?ws=${encodeURIComponent(wsId)}&path=${encodeURIComponent(path)}`;
  const isMarkdown = view?.kind === "text" && languageFor(path) === "markdown";
  const open = (p: string) => {
    setSource(false);
    setRef({ path: p });
  };
  const openRef = (r: string) => {
    const parsed = parseFileRef(r) ?? { path: r };
    setSource(!!parsed.line);
    setRef({ ...parsed, path: resolveFrom(parentOf(path), parsed.path) });
  };
  // Worktrees usually live inside the repository: the deepest folder wins.
  const root = roots
    .filter((r) => path === r.path || path.startsWith(r.path.endsWith("/") ? r.path : `${r.path}/`))
    .reduce<FileRoot | undefined>(
      (a, r) => (a && a.path.length >= r.path.length ? a : r),
      undefined,
    );

  const dir = root?.path ?? ".";
  const repo = `ws=${encodeURIComponent(wsId)}&dir=${encodeURIComponent(dir)}`;
  useEffect(
    () => (changesOn ? fetchJson<Changes>(`api/diff?${repo}`, setChanges) : undefined),
    [changesOn, repo],
  );
  const against = "value" in changes ? changes.value.against : null;
  useEffect(() => {
    if (!changed || !against) return;
    const q = new URLSearchParams({ path: changed.path, against });
    if (changed.oldPath) q.set("old", changed.oldPath);
    if (changed.status === "untracked") q.set("untracked", "1");
    return fetchJson<FileDiff>(`api/diff/file?${repo}&${q}`, setDiff);
  }, [changed, against, repo]);
  const top = "value" in changes ? changes.value.top : dir;

  if (changesOn) {
    const shown = changed ? `${top}/${changed.path}` : top;
    return (
      <div className="files-panel">
        <div className="fp-bar">
          <button
            className="fp-btn fp-up"
            title={changed ? "All changes" : "Files"}
            onClick={() => (changed ? setChanged(null) : setChangesOn(false))}
          >
            <Icon name="up" />
          </button>
          <span className="fp-path" title={shown}>
            <bdi>{changed ? changed.path : "Changes"}</bdi>
          </span>
          {changed && changed.status !== "deleted" && (
            <button
              className="fp-btn"
              title="Open the file"
              onClick={() => {
                setChangesOn(false);
                setChanged(null);
                open(shown);
              }}
            >
              Open
            </button>
          )}
          <button
            className="fp-btn fp-toggle on"
            title="Back to the files"
            aria-pressed="true"
            onClick={() => {
              setChangesOn(false);
              setChanged(null);
            }}
          >
            <Icon name="changes" />
          </button>
        </div>
        <div className="fp-body">
          {!changed && "loading" in changes && <div className="file-note">Loading…</div>}
          {!changed && "error" in changes && (
            <div className="file-note file-error">{changes.error}</div>
          )}
          {!changed && "value" in changes && (
            <ChangesList changes={changes.value} open={setChanged} />
          )}
          {changed && "loading" in diff && <div className="file-note">Loading…</div>}
          {changed && "error" in diff && <div className="file-note file-error">{diff.error}</div>}
          {changed && "value" in diff && (
            <DiffView diff={diff.value} lang={languageFor(changed.path)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="files-panel">
      <div className="fp-bar">
        <button className="fp-btn fp-up" title="Parent folder" onClick={() => open(parentOf(path))}>
          <Icon name="up" />
        </button>
        {roots.length > 1 && (
          <select
            className="fp-roots"
            aria-label="Folder"
            value={root?.path ?? ""}
            onChange={(e) => open(e.target.value)}
          >
            {!root && <option value="">Elsewhere</option>}
            {roots.map((r) => (
              <option key={r.path} value={r.path}>
                {r.label}
              </option>
            ))}
          </select>
        )}
        <span className="fp-path" title={path}>
          <bdi>{shownPath(path, root, roots.length > 1)}</bdi>
        </span>
        {isMarkdown && (
          <button className="fp-btn" onClick={() => setSource((v) => !v)}>
            {source ? "Preview" : "Source"}
          </button>
        )}
        <button
          className="fp-btn"
          title="Copy path"
          onClick={() => {
            navigator.clipboard?.writeText(path).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {view && view.kind !== "dir" && (
          <a className="fp-btn" href={raw} target="_blank" rel="noopener noreferrer">
            Raw
          </a>
        )}
        <button
          className="fp-btn fp-toggle"
          title="Changes against the base branch"
          aria-pressed="false"
          onClick={() => setChangesOn(true)}
        >
          <Icon name="changes" />
        </button>
      </div>
      <div className="fp-body">
        {"loading" in load && <div className="file-note">Loading…</div>}
        {"error" in load && <div className="file-note file-error">{load.error}</div>}
        {view?.kind === "dir" && <DirView view={view} open={open} />}
        {view?.kind === "text" &&
          (isMarkdown && !source ? (
            <div className="file-markdown message-content">
              <FileOpenContext.Provider value={openRef}>
                <MdBlock>{view.content}</MdBlock>
              </FileOpenContext.Provider>
            </div>
          ) : (
            <CodeView content={view.content} lang={languageFor(path)} target={ref} />
          ))}
        {view?.kind === "text" && view.truncated && (
          <div className="file-note">
            Showing the first {formatSize(view.content.length)} of {formatSize(view.size)}.
          </div>
        )}
        {view?.kind === "image" && (
          <div className="file-image">
            <img src={raw} alt={path} />
          </div>
        )}
        {view?.kind === "binary" && (
          <div className="file-note">
            Binary file · {formatSize(view.size)} ·{" "}
            <a href={raw} target="_blank" rel="noopener noreferrer">
              open raw
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
