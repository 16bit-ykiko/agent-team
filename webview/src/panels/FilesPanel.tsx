import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { highlightTree } from "../chat/highlight";
import { MdBlock } from "../chat/markdown";
import { FileOpenContext, parseFileRef, type FileRef } from "../chat/fileRef";
import { formatSize } from "../format";

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
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
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
      {view.path !== "/" && (
        <button className="dir-entry" onClick={() => open(parentOf(view.path))}>
          <span className="dir-entry-icon">↰</span>
          <span className="dir-entry-name">..</span>
        </button>
      )}
      {view.entries.map((e) => (
        <button key={e.name} className="dir-entry" onClick={() => open(`${view.path}/${e.name}`)}>
          <span className="dir-entry-icon">{e.dir ? "📁" : "📄"}</span>
          <span className="dir-entry-name">
            {e.name}
            {e.dir && "/"}
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
// folder listings. Relative paths resolve against `wsId`'s folder; the parent
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
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);

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
    setSource(false);
    setRef({ ...parsed, path: resolveFrom(parentOf(path), parsed.path) });
  };
  // Worktrees usually live inside the repository: the deepest folder wins.
  const root = roots
    .filter((r) => path === r.path || path.startsWith(`${r.path}/`))
    .reduce<FileRoot | undefined>(
      (a, r) => (a && a.path.length >= r.path.length ? a : r),
      undefined,
    );

  return (
    <div className="files-panel">
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
      <div className="fp-bar">
        <button
          className="btn-ghost fp-btn"
          title="Parent folder"
          onClick={() => open(parentOf(path))}
        >
          ↑
        </button>
        <span className="fp-path" title={path}>
          <bdi>{path}</bdi>
        </span>
        {isMarkdown && (
          <button className="btn-ghost fp-btn" onClick={() => setSource((v) => !v)}>
            {source ? "Preview" : "Source"}
          </button>
        )}
        <button
          className="btn-ghost fp-btn"
          title="Copy path"
          onClick={() => {
            void navigator.clipboard?.writeText(path);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {view && view.kind !== "dir" && (
          <a className="btn-ghost fp-btn" href={raw} target="_blank" rel="noopener noreferrer">
            Raw
          </a>
        )}
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
