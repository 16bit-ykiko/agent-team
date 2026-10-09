import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { MdBlock, ProsePathContext } from "../chat/markdown";
import { FileOpenContext, parseFileRef, type FileRef } from "../chat/fileRef";
import { CodeView, languageFor, type FileView } from "../panels/FilesPanel";
import { FileIcon, Icon } from "../panels/Icon";
import { formatSize } from "../format";

// The project's notes on the board page: their folders as a tree on the
// left, a file in full on the right. Paths are as the board writes them:
// notes/... in the project's notes, other relative ones in its repository,
// absolute ones as they are; the server reads nothing outside those two.

// A file the board shows, with a line to bring into view, and why it is
// shown here rather than in VS Code.
export interface BoardFile extends FileRef {
  notice?: string;
}

// The panel open in VS Code's own browser: there a file opens in the editor.
export function inVSCode(ua = navigator.userAgent): boolean {
  return /\bCode(?: - Insiders)?\/\d/.test(ua) && /\bElectron\//.test(ua);
}

// Opens a file of the project in the user's VS Code. When it could not, why,
// unless the file itself is the reason (a folder, missing, outside the
// project): the board's view of it says that.
export async function openInEditor(project: string, file: FileRef): Promise<string | null> {
  try {
    const res = await fetch("api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, path: file.path, line: file.line }),
    });
    if (res.ok) return null;
    if (res.status < 500) return "";
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error || res.statusText || `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function fileUrl(project: string, path: string, raw = false): string {
  return `api/file${raw ? "/raw" : ""}?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`;
}

// Whether the server would read a path the board names: not one climbing
// out of the repository, nor an absolute one outside it (its notes are
// named notes/...).
export function reachable(path: string, root: string): boolean {
  if (path.startsWith("~")) return false;
  if (path.startsWith("/")) return path === root || path.startsWith(`${root}/`);
  return !/^(\.\/)*\.\.(\/|$)/.test(path);
}

// A reference made from inside `from`: ./ and ../ against its folder, the
// rest as the board reads any path.
export function refFrom(from: string, ref: string): string {
  if (!/^\.\.?\//.test(ref)) return ref;
  const parts = from.split("/").slice(0, -1);
  for (const seg of ref.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const joined = parts.join("/");
  return from.startsWith("/") && !joined.startsWith("/") ? `/${joined}` : joined;
}

type Listing =
  { entries: Array<{ name: string; dir: boolean }> } | { error: string; missing: boolean } | null;

// A failure says why, and for a path that is not there what it may have
// meant.
type Failure = { error: string; candidates?: string[] };

function useJson<T>(url: string | null): { value: T } | Failure | null {
  const [state, setState] = useState<{ url: string; result: { value: T } | Failure }>();
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        const body = (await res.json()) as T & Partial<Failure>;
        if (!cancelled) {
          setState({
            url,
            result: res.ok
              ? { value: body }
              : { error: body.error ?? res.statusText, candidates: body.candidates },
          });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setState({ url, result: { error: e instanceof Error ? e.message : String(e) } });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return url && state?.url === url ? state.result : null;
}

// The notes' folders, each listed when it is first opened; the archive
// starts closed, the rest open.
function NotesTree({
  project,
  selected,
  onSelect,
}: {
  project: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set(["notes"]));

  const load = useCallback(
    (dir: string) => {
      setListings((m) => (m.has(dir) ? m : new Map(m).set(dir, null)));
      fetch(fileUrl(project, dir))
        .then(async (res) => {
          const body = (await res.json()) as FileView & { error?: string };
          const listing: Listing =
            res.ok && body.kind === "dir"
              ? { entries: body.entries }
              : { error: body.error ?? "Not a folder", missing: res.status === 404 };
          setListings((m) => new Map(m).set(dir, listing));
          // A folder's subfolders open with it, the archive aside.
          if (dir === "notes" && "entries" in listing) {
            const subs = listing.entries.filter((e) => e.dir && e.name !== "_archive");
            setOpen((o) => new Set([...o, ...subs.map((e) => `notes/${e.name}`)]));
          }
        })
        .catch((e: unknown) =>
          setListings((m) =>
            new Map(m).set(dir, {
              error: e instanceof Error ? e.message : String(e),
              missing: false,
            }),
          ),
        );
    },
    [project],
  );

  // The folders that hold the selected note open too.
  useEffect(() => {
    if (!selected?.startsWith("notes/")) return;
    const parts = selected.split("/").slice(0, -1);
    const dirs = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    setOpen((o) => (dirs.every((d) => o.has(d)) ? o : new Set([...o, ...dirs])));
  }, [selected]);

  useEffect(() => {
    for (const dir of open) if (!listings.has(dir)) load(dir);
  }, [open, listings, load]);

  const toggle = (dir: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const branch = (dir: string, depth: number): ReactNode => {
    const listing = listings.get(dir);
    if (!listing) return depth === 0 ? <div className="bn-note">Loading…</div> : null;
    if ("error" in listing) {
      return (
        <div className="bn-note">
          {depth === 0 && listing.missing ? "No notes yet." : listing.error}
        </div>
      );
    }
    if (depth === 0 && listing.entries.length === 0) {
      return <div className="bn-note">No notes yet.</div>;
    }
    return listing.entries.map((e) => {
      const path = `${dir}/${e.name}`;
      const expanded = open.has(path);
      return (
        <div key={path} role="none">
          <button
            role="treeitem"
            aria-expanded={e.dir ? expanded : undefined}
            aria-selected={!e.dir && path === selected}
            className={`bn-item${e.dir ? " is-dir" : ""}${path === selected ? " selected" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={path}
            onClick={() => (e.dir ? toggle(path) : onSelect(path))}
          >
            {e.dir ? (
              <span className={`bn-caret${expanded ? " open" : ""}`} aria-hidden="true">
                ›
              </span>
            ) : (
              <span className="bn-caret" aria-hidden="true" />
            )}
            <FileIcon name={e.name} dir={e.dir} />
            <span className="bn-name">{e.name}</span>
          </button>
          {e.dir && expanded && branch(path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="bn-tree" role="tree" aria-label="Notes">
      {branch("notes", 0)}
    </div>
  );
}

// One file (or folder) of the project in full: markdown rendered, other
// text as code with its line marked, a folder's entries, an image.
export function FilePreview({
  project,
  root,
  file,
  onRef,
  onClose,
  editor,
}: {
  project: string;
  // The repository's folder: a path found elsewhere than written shows as
  // it is there.
  root: string;
  file: BoardFile;
  // A reference in it, resolved against it.
  onRef: (ref: string) => void;
  onClose: () => void;
  // Offered inside VS Code: the file in the editor.
  editor: boolean;
}) {
  const result = useJson<FileView>(fileUrl(project, file.path));
  const view = result && "value" in result ? result.value : null;
  const markdown = view?.kind === "text" && languageFor(file.path) === "markdown" && !file.line;
  const openRef = useCallback(
    (ref: string) => {
      const parsed = parseFileRef(ref) ?? { path: ref };
      onRef(
        `${refFrom(file.path, parsed.path)}${parsed.line ? `:${parsed.line}${parsed.endLine ? `-${parsed.endLine}` : ""}` : ""}`,
      );
    },
    [file.path, onRef],
  );
  const [failed, setFailed] = useState<string | null>(null);
  const accept = useContext(ProsePathContext);
  const acceptHere = useCallback(
    (ref: string) => accept?.(refFrom(file.path, ref)) ?? true,
    [accept, file.path],
  );
  const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
  const shown =
    view && !/^(\.\/)?notes(\/|$)/.test(file.path) && view.path.startsWith(`${root}/`)
      ? view.path.slice(root.length + 1)
      : file.path;
  const notice = failed ?? file.notice;
  return (
    <section className="bn-preview" aria-label={name}>
      <div className="bn-bar">
        <button className="bp-back bn-back" aria-label="Back to the notes" onClick={onClose}>
          ‹
        </button>
        <span className="bn-path" title={view?.path ?? file.path}>
          <bdi>{shown}</bdi>
        </span>
        {editor && view && view.kind !== "dir" && (
          <button
            className="fp-btn"
            onClick={() =>
              void openInEditor(project, file).then((why) =>
                setFailed(
                  why === null ? null : `VS Code could not open it: ${why || "not a file"}.`,
                ),
              )
            }
            title="Open it in VS Code"
          >
            VS Code
          </button>
        )}
        <button className="side-panel-btn bn-close" aria-label="Close the file" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {notice && <div className="bn-notice">{notice}</div>}
      <div className="bn-body">
        {!result ? (
          <div className="file-note">Loading…</div>
        ) : "error" in result ? (
          <>
            <div className="file-note file-error">{result.error}</div>
            {result.candidates && (
              <div className="dir-view" aria-label="Did you mean">
                <div className="file-note">Did you mean</div>
                {result.candidates.map((c) => (
                  <button key={c} className="dir-entry" onClick={() => onRef(c)}>
                    <FileIcon name={c.split("/").pop() ?? c} dir={false} />
                    <span className="dir-entry-name">{c}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : view?.kind === "dir" ? (
          <div className="dir-view">
            {view.entries.map((e) => (
              <button
                key={e.name}
                className={`dir-entry${e.dir ? " is-dir" : ""}`}
                onClick={() => onRef(`${shown.replace(/\/$/, "")}/${e.name}`)}
              >
                <FileIcon name={e.name} dir={e.dir} />
                <span className="dir-entry-name">{e.name}</span>
              </button>
            ))}
          </div>
        ) : view?.kind === "text" ? (
          markdown ? (
            <FileOpenContext.Provider value={openRef}>
              <ProsePathContext.Provider value={acceptHere}>
                <div className="file-markdown message-content bn-md">
                  <MdBlock>{view.content}</MdBlock>
                </div>
              </ProsePathContext.Provider>
            </FileOpenContext.Provider>
          ) : (
            <CodeView content={view.content} lang={languageFor(file.path)} target={file} />
          )
        ) : view?.kind === "image" ? (
          <div className="file-image">
            <img src={fileUrl(project, file.path, true)} alt={name} />
          </div>
        ) : (
          <div className="file-note">A binary file: nothing to show.</div>
        )}
        {view?.kind === "text" && view.truncated && (
          <div className="file-note">
            Showing the first {formatSize(view.content.length)} of {formatSize(view.size)}.
          </div>
        )}
        {view?.kind === "dir" && view.truncated && (
          <div className="file-note">Only the first entries are listed.</div>
        )}
      </div>
    </section>
  );
}

export function NotesView({
  project,
  root,
  file,
  onOpen,
  onRef,
  onClose,
}: {
  project: string;
  root: string;
  file: BoardFile | null;
  onOpen: (path: string) => void;
  onRef: (ref: string) => void;
  onClose: () => void;
}) {
  const editor = useMemo(() => inVSCode(), []);
  return (
    <div className={`bp-body bn-page${file ? " has-file" : ""}`}>
      <nav className="bp-nav bn-nav" aria-label="Notes">
        <NotesTree project={project} selected={file?.path ?? null} onSelect={onOpen} />
      </nav>
      <main className="bp-main bn-main">
        {file ? (
          <FilePreview
            key={`${file.path}:${file.line ?? ""}`}
            project={project}
            root={root}
            file={file}
            onRef={onRef}
            onClose={onClose}
            editor={editor}
          />
        ) : (
          <div className="bp-empty">
            The lead&apos;s notes: rules, ideas, what each objective found out. Pick one to read it.
          </div>
        )}
      </main>
    </div>
  );
}
