import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MdBlock, ProsePathContext } from "../chat/markdown";
import { FileOpenContext, parseFileRef, type FileRef } from "../chat/fileRef";
import { CodeView, languageFor, type FileView } from "../panels/FilesPanel";
import { FileIcon, Icon } from "../panels/Icon";

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
  return /\bCode\/\d/.test(ua) && /\bElectron\//.test(ua);
}

// Opens a file of the project in the user's VS Code; false when it could not.
export async function openInEditor(project: string, file: FileRef): Promise<boolean> {
  try {
    const res = await fetch("api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, path: file.path, line: file.line }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function fileUrl(project: string, path: string, raw = false): string {
  return `api/file${raw ? "/raw" : ""}?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`;
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

type Listing = { entries: Array<{ name: string; dir: boolean }> } | { error: string } | null;

function useJson<T>(url: string | null): { value: T } | { error: string } | null {
  const [state, setState] = useState<{ url: string; result: { value: T } | { error: string } }>();
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        const body = (await res.json()) as T & { error?: string };
        if (!cancelled) {
          setState({
            url,
            result: res.ok ? { value: body } : { error: body.error ?? res.statusText },
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
              : { error: body.error ?? "Not a folder" };
          setListings((m) => new Map(m).set(dir, listing));
          // A folder's subfolders open with it, the archive aside.
          if (dir === "notes" && "entries" in listing) {
            const subs = listing.entries.filter((e) => e.dir && e.name !== "_archive");
            setOpen((o) => new Set([...o, ...subs.map((e) => `notes/${e.name}`)]));
          }
        })
        .catch((e: unknown) =>
          setListings((m) =>
            new Map(m).set(dir, { error: e instanceof Error ? e.message : String(e) }),
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
      return depth === 0 ? (
        <div className="bn-note">No notes yet.</div>
      ) : (
        <div className="bn-note">{listing.error}</div>
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
  file,
  onRef,
  onClose,
  editor,
}: {
  project: string;
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
  const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
  return (
    <section className="bn-preview" aria-label={name}>
      <div className="bn-bar">
        <button className="bp-back bn-back" aria-label="Back to the notes" onClick={onClose}>
          ‹
        </button>
        <span className="bn-path" title={view?.path ?? file.path}>
          <bdi>{file.path}</bdi>
        </span>
        {editor && (
          <button
            className="fp-btn"
            onClick={() => void openInEditor(project, file)}
            title="Open it in VS Code"
          >
            VS Code
          </button>
        )}
        <button className="side-panel-btn bn-close" aria-label="Close the file" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {file.notice && <div className="bn-notice">{file.notice}</div>}
      <div className="bn-body">
        {!result ? (
          <div className="file-note">Loading…</div>
        ) : "error" in result ? (
          <div className="file-note file-error">{result.error}</div>
        ) : view?.kind === "dir" ? (
          <div className="dir-view">
            {view.entries.map((e) => (
              <button
                key={e.name}
                className={`dir-entry${e.dir ? " is-dir" : ""}`}
                onClick={() => onRef(`${file.path.replace(/\/$/, "")}/${e.name}`)}
              >
                <FileIcon name={e.name} dir={e.dir} />
                <span className="dir-entry-name">{e.name}</span>
              </button>
            ))}
          </div>
        ) : view?.kind === "text" ? (
          markdown ? (
            <FileOpenContext.Provider value={openRef}>
              <ProsePathContext.Provider value={true}>
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
      </div>
    </section>
  );
}

export function NotesView({
  project,
  file,
  onOpen,
  onRef,
  onClose,
}: {
  project: string;
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
