import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { FilesPanel, languageFor, type FileRoot, type FileView } from "../src/panels/FilesPanel";
import { fileRoots } from "../src/panels/scope";
import { autoPanelWidth } from "../src/panels/SidePanel";
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

  it("does not take commands, routes, patterns, sites or Windows paths for a file", () => {
    for (const s of [
      "/compact",
      "/model",
      "/\\d+/",
      "src/*.ts",
      "C:\\Users\\me\\a.ts",
      "C:\\Users\\me\\a.ts:12",
      "C:/Users/me/a.ts",
      "example.com/index.html",
    ]) {
      expect(parseFileRef(s), s).toBeNull();
    }
  });

  it("knows files by name, line anchors without an L, and drops other anchors", () => {
    expect(parseFileRef(".gitignore")).toEqual({ path: ".gitignore" });
    expect(parseFileRef("Makefile:3")).toEqual({ path: "Makefile", line: 3 });
    expect(parseFileRef("docker/Dockerfile")).toEqual({ path: "docker/Dockerfile" });
    expect(parseFileRef("src/a.ts#12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseFileRef("docs/guide.md#setup")).toEqual({ path: "docs/guide.md" });
    expect(parseFileRef("/api/file")).toEqual({ path: "/api/file" });
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

  it("shows a markdown file opened at a line as source, with the line marked", async () => {
    views = {
      "docs/plan.md": {
        kind: "text",
        path: "/w/docs/plan.md",
        size: 20,
        content: "# Plan\n\n- one\n- two\n",
        truncated: false,
      },
    };
    const { container, getByText } = open("docs/plan.md", 3);
    await waitFor(() => expect(container.querySelector(".code-mark")).not.toBeNull());
    fireEvent.click(getByText("Preview"));
    expect(container.querySelector(".file-markdown h1")).not.toBeNull();
  });

  it("goes up from a path the server has not resolved, not to the root", async () => {
    views = {};
    const { container } = open(".");
    await waitFor(() => expect(container.querySelector(".file-error")).not.toBeNull());
    fireEvent.click(container.querySelector('[title="Parent folder"]')!);
    await waitFor(() => expect(requested.at(-1)).toBe(".."));
  });

  it("says Copied only when the path was copied", async () => {
    views = {};
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const { container, getByTitle } = open("x");
    await waitFor(() => expect(container.querySelector(".file-error")).not.toBeNull());
    fireEvent.click(getByTitle("Copy path"));
    await Promise.resolve();
    expect(getByTitle("Copy path").textContent).toBe("Copy");
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

describe("automatic panel widths", () => {
  it("give code more room than lists, and grow with the window within bounds", () => {
    expect([1000, 1440, 2560, 3840].map((w) => autoPanelWidth("list", w))).toEqual([
      380, 380, 560, 560,
    ]);
    expect([1000, 1440, 2560, 3840].map((w) => autoPanelWidth("wide", w))).toEqual([
      560, 605, 1075, 1100,
    ]);
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

  const refs = (text: string) => {
    const open = vi.fn();
    const { container, unmount } = md(text, open);
    for (const r of container.querySelectorAll(".file-ref")) fireEvent.click(r);
    const html = container.innerHTML;
    unmount();
    return { calls: open.mock.calls.map((c: unknown[]) => c[0]), html };
  };

  it("opens links whose target has a line, or a file:// scheme", () => {
    expect(refs("[a](a.ts:12) and [b](file:///home/me/b.ts)").calls).toEqual([
      "a.ts:12",
      "/home/me/b.ts",
    ]);
  });

  it("opens link targets decoded, without a query or a section anchor", () => {
    expect(
      refs("[说明](docs/说明.md) [x](<my file.md>) [s](docs/setup.md#install) [q](a.ts?plain=1)")
        .calls,
    ).toEqual(["docs/说明.md", "my file.md", "docs/setup.md", "a.ts"]);
    expect(refs("[l](src/a.ts#L3)").calls).toEqual(["src/a.ts#L3"]);
  });

  it("leaves page anchors plain and mail links as links", () => {
    const { calls, html } = refs("[Install](#install) [mail](mailto:a@b.c)");
    expect(calls).toEqual([]);
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it("opens code inside a link once, as the link", () => {
    expect(refs("[`src/a.ts`](https://github.com/o/r/blob/main/src/a.ts#L3)").calls).toEqual([]);
    expect(refs("[`src/a.ts`](src/a.ts:12)").calls).toEqual(["src/a.ts:12"]);
  });

  it("opens from the keyboard", () => {
    const open = vi.fn();
    const { container } = md("See `src/a.ts:3`.", open);
    const ref = container.querySelector(".file-ref") as HTMLElement;
    expect(ref.tabIndex).toBe(0);
    fireEvent.keyDown(ref, { key: "Enter" });
    expect(open).toHaveBeenCalledWith("src/a.ts:3");
  });

  it("stays plain text where there is no workspace to open it in", () => {
    const { container } = md("Fixed in `service/src/index.ts:1182`.");
    expect(container.querySelector(".file-ref")).toBeNull();
  });
});
