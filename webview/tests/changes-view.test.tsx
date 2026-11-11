// The Files panel's icons and the branch's changes: the list against the
// base, a file's diff with both line numbers, and lines that never wrap.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import css from "../src/styles.css?raw";
import { FilesPanel } from "../src/panels/FilesPanel";
import { ChangesList, changeTree, parseDiff } from "../src/panels/ChangesView";
import { fileIconName } from "../src/panels/Icon";

const listing = {
  kind: "dir",
  path: "/w",
  truncated: false,
  entries: [
    { name: "src", dir: true, size: 0 },
    { name: "README.md", dir: false, size: 10 },
    { name: "main.cpp", dir: false, size: 10 },
    { name: "CMakeLists.txt", dir: false, size: 10 },
  ],
};
const changes = {
  top: "/w",
  branch: "feature",
  base: "origin/main",
  against: "a".repeat(40),
  truncated: false,
  files: [
    { path: "src/lexer.cpp", status: "modified", added: 3, removed: 1 },
    { path: "docs/new.md", status: "untracked", added: 2, removed: 0 },
    { path: "old.png", status: "deleted", added: null, removed: null },
  ],
};
const long = `${"x".repeat(400)} // a line far wider than the panel`;
const diff = {
  path: "src/lexer.cpp",
  binary: false,
  truncated: false,
  diff: [
    "@@ -10,3 +10,5 @@ int lex() {",
    " int a = 1;",
    "-int b = 2;",
    "+int b = 3;",
    `+${long}`,
    "+int c = 4;",
    " return a;",
    "\\ No newline at end of file",
    "",
  ].join("\n"),
};

describe("the Files panel's icons and changes", () => {
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        const body = url.startsWith("api/diff/file")
          ? diff
          : url.startsWith("api/diff")
            ? changes
            : listing;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const panel = () =>
    render(<FilesPanel wsId="w1" target={{ path: "." }} roots={[{ label: "w", path: "/w" }]} />);

  it("shows files and folders with the icons vscode-icons gives them in VS Code", async () => {
    const { container } = panel();
    await waitFor(() => expect(container.querySelectorAll(".dir-entry")).toHaveLength(4));
    const icons = [...container.querySelectorAll<HTMLImageElement>(".dir-entry img.file-icon")];
    expect(icons.map((i) => i.getAttribute("src"))).toEqual([
      "file-icons/folder_type_src.svg",
      "file-icons/file_type_markdown.svg",
      "file-icons/file_type_cpp.svg",
      "file-icons/file_type_cmake.svg",
    ]);
    // A file by name, by its longest extension, by language; a folder by
    // name; else the defaults.
    expect(
      ["package.json", ".gitignore", "src/a.test.ts", "a.tsx", "x.toml", "notes.unknown"].map((n) =>
        fileIconName(n),
      ),
    ).toEqual([
      "file_type_npm",
      "file_type_git",
      "file_type_testts",
      "file_type_reactts",
      "file_type_toml",
      "default_file",
    ]);
    expect(["node_modules", ".git/", "Tests", "random"].map((n) => fileIconName(n, true))).toEqual([
      "folder_type_node",
      "folder_type_git",
      "folder_type_test",
      "default_folder",
    ]);
  });

  it("lists the changes against the base, then a file's diff, and goes back", async () => {
    const { container, getByTitle } = panel();
    await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
    fireEvent.click(getByTitle("Changes against the base branch"));
    await waitFor(() => expect(container.querySelector(".changes")).not.toBeNull());
    expect(urls.at(-1)).toBe("api/diff?ws=w1&dir=%2Fw");
    expect(container.querySelector(".changes-head")!.textContent).toBe(
      "against origin/main · 3 files",
    );
    // The lines of all of them over the list, of one over its diff.
    expect(container.querySelector(".fp-bar .change-count")!.textContent).toBe("+5 −1");
    const rows = [...container.querySelectorAll(".change-entry")];
    expect(rows.map((r) => r.querySelector(".change-status")!.textContent)).toEqual([
      "U",
      "M",
      "D",
    ]);
    expect(rows[2].querySelector(".change-count")!.textContent).toBe("binary");

    fireEvent.click(rows[1]);
    await waitFor(() => expect(container.querySelector(".diff-view")).not.toBeNull());
    expect(container.querySelector(".fp-bar .change-count")!.textContent).toBe("+3 −1");
    expect(urls.at(-1)).toBe(
      `api/diff/file?ws=w1&dir=%2Fw&path=src%2Flexer.cpp&against=${"a".repeat(40)}`,
    );
    const lines = [...container.querySelectorAll(".diff-row")].map((r) => [
      r.className.replace("diff-row diff-", ""),
      [...r.querySelectorAll(".diff-num")].map((n) => n.textContent).join(","),
    ]);
    expect(lines).toEqual([
      ["hunk", ""],
      ["context", "10,10"],
      ["del", "11,"],
      ["add", ",11"],
      ["add", ",12"],
      ["add", ",13"],
      ["context", "12,14"],
      ["note", ""],
    ]);
    expect(
      container.querySelector(".diff-code .hljs-type, .diff-code .hljs-keyword"),
    ).not.toBeNull();

    fireEvent.click(getByTitle("All changes"));
    await waitFor(() => expect(container.querySelector(".changes")).not.toBeNull());
    // A file git does not know yet is asked for as such.
    fireEvent.click(container.querySelectorAll(".change-entry")[0]);
    await waitFor(() => expect(urls.at(-1)).toContain("path=docs%2Fnew.md"));
    expect(urls.at(-1)).toContain("&untracked=1");
    await waitFor(() => expect(container.querySelector(".diff-view")).not.toBeNull());
    fireEvent.click(getByTitle("All changes"));
    await waitFor(() => expect(container.querySelector(".changes")).not.toBeNull());
    fireEvent.click(getByTitle("Files"));
    await waitFor(() => expect(container.querySelector(".dir-view:not(.changes)")).not.toBeNull());
  });

  it("lists the changes as folders, a folder of one folder as one row, each to fold", async () => {
    changes.files = [
      { path: "src/sched/batch.cpp", status: "modified", added: 1, removed: 1 },
      { path: "src/sched/queue.cpp", status: "added", added: 9, removed: 0 },
      { path: "src/a.cpp", status: "modified", added: 1, removed: 0 },
      { path: "docs/guide/intro.md", status: "modified", added: 2, removed: 0 },
      { path: "README.md", status: "modified", added: 1, removed: 0 },
    ];
    try {
      const { container, getByTitle } = panel();
      await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      const rows = () =>
        [...container.querySelectorAll(".changes .dir-entry")].map(
          (r) =>
            `${(r as HTMLElement).style.getPropertyValue("--depth")}:${r.querySelector(".dir-entry-name")!.textContent}`,
        );
      expect(rows()).toEqual([
        "0:docs/guide",
        "1:intro.md",
        "0:src",
        "1:sched",
        "2:batch.cpp",
        "2:queue.cpp",
        "1:a.cpp",
        "0:README.md",
      ]);
      fireEvent.click(getByTitle("src/sched"));
      expect(getByTitle("src/sched").getAttribute("aria-expanded")).toBe("false");
      expect(rows()).toEqual([
        "0:docs/guide",
        "1:intro.md",
        "0:src",
        "1:sched",
        "1:a.cpp",
        "0:README.md",
      ]);
      fireEvent.click(getByTitle("src"));
      expect(rows()).toEqual(["0:docs/guide", "1:intro.md", "0:src", "0:README.md"]);
      fireEvent.click(getByTitle("src"));
      expect(rows()).toContain("1:sched");
      expect(rows()).not.toContain("2:batch.cpp");

      // Folds stay as they were after a diff, and after the files.
      fireEvent.click(getByTitle("README.md"));
      await waitFor(() => expect(container.querySelector(".diff-view")).not.toBeNull());
      fireEvent.click(getByTitle("All changes"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      expect(rows()).not.toContain("2:batch.cpp");
      fireEvent.click(getByTitle("Files"));
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".changes .dir-entry")).not.toBeNull());
      expect(rows()).not.toContain("2:batch.cpp");
    } finally {
      changes.files = [
        { path: "src/lexer.cpp", status: "modified", added: 3, removed: 1 },
        { path: "docs/new.md", status: "untracked", added: 2, removed: 0 },
        { path: "old.png", status: "deleted", added: null, removed: null },
      ];
    }
  });

  it("names a nested repository git lists with a slash", () => {
    const tree = changeTree([
      { path: "wt/feat/", status: "untracked", added: null, removed: null },
      { path: "wt/a.txt", status: "untracked", added: 1, removed: 0 },
    ]);
    expect(tree.dirs.map((d) => d.name)).toEqual(["wt"]);
    expect(tree.dirs[0].files.map((f) => f.path)).toEqual(["wt/a.txt", "wt/feat/"]);
    const { container } = render(
      <ChangesList
        changes={{ ...changes, files: tree.dirs[0].files }}
        open={() => {}}
        closed={new Set()}
        toggle={() => {}}
      />,
    );
    expect(
      [...container.querySelectorAll(".change-entry .dir-entry-name")].map((n) => n.textContent),
    ).toEqual(["a.txt", "feat/"]);
  });

  it("counts only what there is: no −0 when nothing was removed", async () => {
    changes.files = changes.files.filter((f) => f.removed === 0);
    try {
      const { container, getByTitle } = panel();
      await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".changes")).not.toBeNull());
      expect(container.querySelector(".changes-head")!.textContent).toBe(
        "against origin/main · 1 file",
      );
      expect(container.querySelector(".fp-bar .change-count")!.textContent).toBe("+2 ");
    } finally {
      changes.files = [
        { path: "src/lexer.cpp", status: "modified", added: 3, removed: 1 },
        { path: "docs/new.md", status: "untracked", added: 2, removed: 0 },
        { path: "old.png", status: "deleted", added: null, removed: null },
      ];
    }
  });

  it("never wraps a line of code or of a diff: it scrolls sideways", async () => {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.appendChild(sheet);
    try {
      const { container, getByTitle } = panel();
      await waitFor(() => expect(container.querySelector(".dir-view")).not.toBeNull());
      fireEvent.click(getByTitle("Changes against the base branch"));
      await waitFor(() => expect(container.querySelector(".change-entry")).not.toBeNull());
      fireEvent.click(container.querySelector(".change-entry")!);
      await waitFor(() => expect(container.querySelector(".diff-row")).not.toBeNull());
      const row = [...container.querySelectorAll(".diff-row")].find((r) =>
        r.textContent?.includes("a line far wider"),
      )!;
      expect(getComputedStyle(row).whiteSpace).toBe("pre");
      expect(getComputedStyle(container.querySelector(".diff-view")!).overflow).toBe("auto");
      expect(getComputedStyle(container.querySelector(".diff-gutter")!).position).toBe("sticky");
      // The sign stays with the numbers when the code scrolls sideways.
      expect(row.querySelector(".diff-gutter .diff-sign")!.textContent).toBe("+");
      const inner = container.querySelector(".diff-inner") as HTMLElement;
      expect(inner.style.getPropertyValue("--diff-digits")).toBe("2ch");
      const code = document.createElement("pre");
      code.className = "code-text";
      document.body.appendChild(code);
      expect(getComputedStyle(code).whiteSpace).toBe("pre");
      code.remove();
    } finally {
      sheet.remove();
    }
  });

  it("reads a diff's line numbers on both sides", () => {
    expect(parseDiff("@@ -1 +1,2 @@\n-a\n+b\n+c\n")).toEqual([
      { kind: "hunk", text: "@@ -1 +1,2 @@" },
      { kind: "del", old: 1, text: "a" },
      { kind: "add", new: 1, text: "b" },
      { kind: "add", new: 2, text: "c" },
    ]);
  });
});
