import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { FilesPanel, languageFor, type FileRoot, type FileView } from "../src/panels/FilesPanel";
import { fileRoots } from "../src/panels/scope";
import { FileOpenContext, parseFileRef } from "../src/chat/fileRef";
import { MdBlock } from "../src/chat/markdown";
import type { Workspace } from "../src/state/useServer";

describe("parseFileRef", () => {
  it("reads paths with lines and ranges", () => {
    expect(parseFileRef("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parseFileRef("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("src/a.ts:12-20")).toEqual({ path: "src/a.ts", line: 12, endLine: 20 });
    expect(parseFileRef("src/a.ts:12:5")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("a.cpp#L3-L9")).toEqual({ path: "a.cpp", line: 3, endLine: 9 });
    expect(parseFileRef("/tmp/report")).toEqual({ path: "/tmp/report" });
    expect(parseFileRef("~/notes/")).toEqual({ path: "~/notes/" });
    expect(parseFileRef("README.md")).toEqual({ path: "README.md" });
  });

  it("does not take code or prose for a file", () => {
    for (const s of ["ws.send", "true/false", "npm run build", "https://x.com/a.ts", ""]) {
      expect(parseFileRef(s), s).toBeNull();
    }
  });
});

describe("languageFor", () => {
  it("maps file names to highlighter languages", () => {
    expect(languageFor("/a/b.tsx")).toBe("typescript");
    expect(languageFor("x/Makefile")).toBe("makefile");
    expect(languageFor("CMakeLists.txt")).toBeNull();
    expect(languageFor("notes.MD")).toBe("markdown");
  });
});

describe("FilesPanel", () => {
  let views: Record<string, FileView | { error: string; status: number }>;
  const requested: string[] = [];

  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = new URLSearchParams(url.split("?")[1]).get("path")!;
        requested.push(path);
        const v = views[path] ?? { error: "No such file or directory", status: 404 };
        const status = "status" in v ? v.status : 200;
        return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(v) });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (path: string, line?: number, endLine?: number, roots: FileRoot[] = []) =>
    render(<FilesPanel wsId="w1" target={{ path, line, endLine }} roots={roots} />);

  it("shows code with line numbers, highlighted, marking the referenced lines", async () => {
    views = {
      "src/a.ts": {
        kind: "text",
        path: "/w/src/a.ts",
        size: 40,
        content: "const a = 1;\nconst b = 2;\nexport { a, b };\n",
        truncated: false,
      },
    };
    const { container } = open("src/a.ts", 2, 3);
    await waitFor(() => expect(container.querySelector(".code-view")).not.toBeNull());
    expect(container.querySelector(".code-gutter")!.textContent).toBe("1\n2\n3");
    expect(container.querySelector(".code-text .hljs-keyword")).not.toBeNull();
    const mark = container.querySelector(".code-mark") as HTMLElement;
    expect([mark.style.top, mark.style.height]).toEqual(["18px", "36px"]);
    expect(container.querySelector(".fp-path")!.textContent).toBe("/w/src/a.ts");
  });

  it("lists a folder and opens what is clicked", async () => {
    views = {
      ".": {
        kind: "dir",
        path: "/w",
        truncated: false,
        entries: [
          { name: "src", dir: true, size: 0 },
          { name: "README.md", dir: false, size: 2048 },
        ],
      },
    };
    const { container, getByText } = open(".");
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(getByText("2.0 KB")).toBeTruthy();
    fireEvent.click(getByText("src/"));
    await waitFor(() => expect(requested.at(-1)).toBe("/w/src"));
  });

  it("renders markdown, with its source a click away and relative links resolved", async () => {
    views = {
      "docs/guide.md": {
        kind: "text",
        path: "/w/docs/guide.md",
        size: 30,
        content: "# Guide\n\nSee [the api](api/ref.md#L4).\n",
        truncated: false,
      },
    };
    const { container, getByText } = open("docs/guide.md");
    await waitFor(() => expect(container.querySelector(".file-markdown h1")).not.toBeNull());
    fireEvent.click(getByText("Source"));
    expect(container.querySelector(".code-view")).not.toBeNull();
    fireEvent.click(getByText("Preview"));
    fireEvent.click(container.querySelector(".file-markdown .file-ref")!);
    await waitFor(() => expect(requested.at(-1)).toBe("/w/docs/api/ref.md"));
  });

  it("shows images, names binaries, and reports errors", async () => {
    views = {
      "p.png": { kind: "image", path: "/w/p.png", size: 10 },
      "b.bin": { kind: "binary", path: "/w/b.bin", size: 3000 },
    };
    const img = open("p.png");
    await waitFor(() => expect(img.container.querySelector("img")).not.toBeNull());
    expect(img.container.querySelector("img")!.getAttribute("src")).toBe(
      "api/file/raw?ws=w1&path=%2Fw%2Fp.png",
    );
    img.unmount();
    const bin = open("b.bin");
    await waitFor(() => expect(bin.container.textContent).toContain("Binary file · 2.9 KB"));
    bin.unmount();
    const missing = open("gone.txt");
    await waitFor(() =>
      expect(missing.container.querySelector(".file-error")!.textContent).toBe(
        "No such file or directory",
      ),
    );
  });

  it("switches between the project's folders, naming a path outside them", async () => {
    views = {
      "/repo": { kind: "dir", path: "/repo", truncated: false, entries: [] },
      "/repo/.worktrees/fix": {
        kind: "dir",
        path: "/repo/.worktrees/fix",
        truncated: false,
        entries: [],
      },
      "/tmp/x.log": { kind: "text", path: "/tmp/x.log", size: 2, content: "x\n", truncated: false },
    };
    const roots = [
      { label: "repo · main", path: "/repo" },
      { label: "fix · fix/crash", path: "/repo/.worktrees/fix" },
    ];
    const { container, getByLabelText } = open("/repo", undefined, undefined, roots);
    const select = getByLabelText("Folder") as HTMLSelectElement;
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(select.value).toBe("/repo");
    fireEvent.change(select, { target: { value: "/repo/.worktrees/fix" } });
    await waitFor(() => expect(requested.at(-1)).toBe("/repo/.worktrees/fix"));
    await waitFor(() => expect(select.value).toBe("/repo/.worktrees/fix"));
    const elsewhere = open("/tmp/x.log", undefined, undefined, roots);
    await waitFor(() => expect(elsewhere.container.querySelector(".code-view")).not.toBeNull());
    const other = elsewhere.getAllByLabelText("Folder").at(-1) as HTMLSelectElement;
    expect(other.value).toBe("");
    expect(other.selectedOptions[0].textContent).toBe("Elsewhere");
  });

  it("offers no folder choice for a single workspace", async () => {
    views = { ".": { kind: "dir", path: "/w", truncated: false, entries: [] } };
    const { container, queryByLabelText } = open(".", undefined, undefined, [
      { label: "w", path: "/w" },
    ]);
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    expect(queryByLabelText("Folder")).toBeNull();
  });
});

describe("fileRoots", () => {
  const ws = (id: string, cwd: string, over: Partial<Workspace> = {}): Workspace =>
    ({ id, name: id, cwd, agents: [], messages: [], createdAt: 0, ...over }) as Workspace;

  it("lists each live session's folder once, with its branch", () => {
    expect(
      fileRoots([
        ws("lead", "/repo", { git: { branch: "main" } as Workspace["git"] }),
        ws("w1", "/repo"),
        ws("w2", "/repo/.worktrees/fix", { git: { branch: "fix/crash" } as Workspace["git"] }),
        ws("old", "/repo/.worktrees/old", { archivedAt: 1 }),
      ]),
    ).toEqual([
      { label: "repo · main", path: "/repo" },
      { label: "fix · fix/crash", path: "/repo/.worktrees/fix" },
    ]);
  });
});

describe("file references in replies", () => {
  const md = (text: string, open?: (r: string) => void) =>
    render(
      <FileOpenContext.Provider value={open ?? null}>
        <MdBlock>{text}</MdBlock>
      </FileOpenContext.Provider>,
    );

  it("opens inline code that names a file, and local links", () => {
    const open = vi.fn();
    const { container } = md(
      "Fixed in `service/src/index.ts:1182`, see [notes](/tmp/notes.md). Call `ws.send`.",
      open,
    );
    const refs = [...container.querySelectorAll(".file-ref")];
    expect(refs.map((r) => r.textContent)).toEqual(["service/src/index.ts:1182", "notes"]);
    fireEvent.click(refs[0]);
    fireEvent.click(refs[1]);
    expect(open.mock.calls).toEqual([["service/src/index.ts:1182"], ["/tmp/notes.md"]]);
  });

  it("stays plain text where there is no workspace to open it in", () => {
    const { container } = md("Fixed in `service/src/index.ts:1182`.");
    expect(container.querySelector(".file-ref")).toBeNull();
  });
});
