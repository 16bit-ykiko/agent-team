// The board's notes view and the files its text names: paths written in
// prose become links, a link opens the file on the board (or in VS Code when
// the panel is open in VS Code's own browser), and a note's own links
// resolve against it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, within, waitFor } from "@testing-library/react";
import { BoardPage } from "../src/project/BoardPage";
import { InlineMd, MdBlock, ProsePathContext, prosePaths } from "../src/chat/markdown";
import { FileOpenContext } from "../src/chat/fileRef";
import { inVSCode, reachable, refFrom } from "../src/project/NotesView";
import type { IssueModules, Objective, Project } from "../src/state/useServer";

const o = (id: string, over: Partial<Objective> = {}): Objective => ({
  id,
  area: id.split("/")[0],
  title: id,
  goal: `goal of ${id}`,
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: 1_800_000_000_000,
  ...over,
});

const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [
    o("release/docs", {
      title: "Docs truth",
      context: "清单在 notes/release/docs-truth.md。代码见 src/server/a.cpp:12。",
      tasks: [
        { id: "t1", text: "规则进 notes/rules/cli.md", state: "todo" },
        {
          id: "t2",
          text: "改 `src/server/a.cpp:2`，再看 sched/batch.cpp 和 notes/release/",
          state: "todo",
        },
      ],
      dependsOn: ["release/other"],
    }),
    o("release/other", { title: "Other, see notes/ideas.md" }),
  ],
};

// The server's files, as api/file answers for project p1.
const FILES: Record<string, unknown> = {
  notes: {
    kind: "dir",
    path: "/data/notes",
    entries: [
      { name: "_archive", dir: true, size: 0 },
      { name: "release", dir: true, size: 0 },
      { name: "rules", dir: true, size: 0 },
      { name: "ideas.md", dir: false, size: 10 },
    ],
    truncated: false,
  },
  "notes/release": {
    kind: "dir",
    path: "/data/notes/release",
    entries: [{ name: "docs-truth.md", dir: false, size: 10 }],
    truncated: false,
  },
  "notes/rules": {
    kind: "dir",
    path: "/data/notes/rules",
    entries: [{ name: "cli.md", dir: false, size: 10 }],
    truncated: false,
  },
  "notes/release/docs-truth.md": {
    kind: "text",
    path: "/data/notes/release/docs-truth.md",
    size: 40,
    content:
      "# Docs truth\n\nSee [the ideas](../ideas.md), notes/rules/cli.md and cli/format.md.\n",
    truncated: false,
  },
  "notes/ideas.md": {
    kind: "text",
    path: "/data/notes/ideas.md",
    size: 10,
    content: "# Ideas\n",
    truncated: false,
  },
  "notes/rules/cli.md": {
    kind: "text",
    path: "/data/notes/rules/cli.md",
    size: 10,
    content: "# CLI rules\n\nSee [the engine](./engine.md).\n",
    truncated: false,
  },
  // Written from src/: the server finds it there.
  "sched/batch.cpp": {
    kind: "text",
    path: "/repo/clice/src/sched/batch.cpp",
    ref: "src/sched/batch.cpp",
    size: 10,
    content: "void run();\n",
    truncated: false,
  },
  "src/sched/batch.cpp": {
    kind: "text",
    path: "/repo/clice/src/sched/batch.cpp",
    ref: "src/sched/batch.cpp",
    size: 3_000_000,
    content: "汉".repeat(1000),
    truncated: true,
  },
  "rules/cli.md": {
    kind: "text",
    path: "/data/notes/rules/cli.md",
    ref: "notes/rules/cli.md",
    size: 10,
    content: "# CLI rules\n",
    truncated: false,
  },
  "src/server/a.cpp": {
    kind: "text",
    path: "/repo/clice/src/server/a.cpp",
    size: 30,
    content: "int a;\nint b;\n",
    truncated: false,
  },
};

let requests: string[];
let opens: Array<Record<string, unknown>>;
// What api/open meets: VS Code there, not there, or no server at all.
let editor: "up" | "down" | "offline";
// Paths api/file fails on.
let broken: Set<string>;

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  requests = [];
  opens = [];
  editor = "up";
  broken = new Set();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      requests.push(url);
      if (url === "api/open") {
        const body = JSON.parse(init?.body as string) as { path: string };
        opens.push(body);
        const file = FILES[body.path.replace(/\/$/, "")] as { kind: string } | undefined;
        if (editor === "offline") return Promise.reject(new TypeError("Failed to fetch"));
        if (!file) return reply(404, { error: "No such file or directory" });
        if (file.kind === "dir") return reply(400, { error: "Not a file" });
        return editor === "up"
          ? reply(200, { opened: body.path })
          : reply(503, { error: "No VS Code window is connected" });
      }
      const q = new URL(url, "http://x").searchParams;
      const path = (q.get("path") ?? "").replace(/\/$/, "");
      if (broken.has(path)) return reply(500, { error: "Permission denied" });
      if (path === "cli/format.md") {
        return reply(404, {
          error: "No such file or directory",
          candidates: ["docs/en/cli/format.md", "notes/rules/cli.md"],
        });
      }
      const body = q.get("project") === "p1" ? FILES[path] : undefined;
      return body ? reply(200, body) : reply(404, { error: "No such file or directory" });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function board(ua?: string, issues?: IssueModules) {
  if (ua) vi.stubGlobal("navigator", { ...navigator, userAgent: ua });
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  return render(<BoardPage project={project} issues={issues} sessions={new Map()} {...props} />);
}
const objective = (container: HTMLElement) => {
  fireEvent.click(container.querySelector('[data-objective="release/docs"]')!);
  return screen.getByRole("complementary", { name: "Docs truth" });
};
const preview = () => screen.findByRole("region", { name: /\.(md|cpp)$/ });
const VSCODE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.140.0 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";

describe("paths in prose", () => {
  it("are those with a folder, a file or a trailing slash, without the sentence's stop", () => {
    const found = (t: string) => prosePaths(t).map((f) => f.text);
    expect(
      found("法进 notes/ideas.md。清单在 notes/release/docs-truth.md，见 src/a.cpp:12."),
    ).toEqual(["notes/ideas.md", "notes/release/docs-truth.md", "src/a.cpp:12"]);
    expect(found("规则进 notes/rules/，剩下的")).toEqual(["notes/rules/"]);
    expect(found("R/V/H, and/or, https://example.com/a.md, a.md, 2026/10/09")).toEqual([]);
    // Slashes between words, alternatives, and a brace expansion.
    for (const t of [
      "孤儿/ABA/无上界问题",
      "客户端/inspect/索引快照",
      "UTF-16/CRLF/代理对",
      "zig/emscripten/裸机",
      "改成了 .cppm/.cpp。",
      "读 clice.toml/compile_commands.json",
      "README/CHANGELOG 都改",
      "docs/{en,zh}/cli/analyze.md",
    ]) {
      expect(found(t), t).toEqual([]);
    }
    expect(found("见 @types/node/index.d.ts、$XDG_CACHE_HOME/clice/、a+b/c.md")).toEqual([]);
    expect(found("见.github/workflows/ci.yml和.clangd/index/")).toEqual([
      ".github/workflows/ci.yml",
      ".clangd/index/",
    ]);
  });

  it("link only when the board can open them", () => {
    const root = "/repo/clice";
    expect(reachable("src/a.cpp", root)).toBe(true);
    expect(reachable("notes/a.md", root)).toBe(true);
    expect(reachable("/repo/clice/src/a.cpp", root)).toBe(true);
    expect(reachable("../repro/a.cpp", root)).toBe(false);
    expect(reachable("/tmp/hunt/a.cpp", root)).toBe(false);
    expect(reachable("/repo/clice-old/a.cpp", root)).toBe(false);
    expect(reachable("~/x/a.cpp", root)).toBe(false);
    expect(reachable("src/../../x.cpp", root)).toBe(false);
    expect(reachable("notes/../../x.md", root)).toBe(false);
    expect(reachable("src/../a.cpp", root)).toBe(true);
    const { container } = render(
      <FileOpenContext.Provider value={vi.fn()}>
        <ProsePathContext.Provider value={(p) => reachable(p, root)}>
          <MdBlock>{"见 /tmp/hunt/a.cpp、`../repro/b.cpp`、[c](/tmp/c.md) 和 src/d.cpp。"}</MdBlock>
        </ProsePathContext.Provider>
      </FileOpenContext.Provider>,
    );
    expect([...container.querySelectorAll(".file-ref")].map((e) => e.textContent)).toEqual([
      "src/d.cpp",
    ]);
  });

  it("link only where the board turns them on", () => {
    const open = vi.fn();
    const text = "见 notes/ideas.md。";
    const { container, rerender } = render(<MdBlock>{text}</MdBlock>);
    expect(container.querySelector(".file-ref")).toBeNull();
    rerender(
      <FileOpenContext.Provider value={open}>
        <ProsePathContext.Provider value={() => true}>
          <MdBlock>{text}</MdBlock>
        </ProsePathContext.Provider>
      </FileOpenContext.Provider>,
    );
    fireEvent.click(container.querySelector(".file-ref")!);
    expect(open).toHaveBeenCalledWith("notes/ideas.md");
  });

  it("make one link of a code span in a link", () => {
    const open = vi.fn();
    const { container } = render(
      <FileOpenContext.Provider value={open}>
        <ProsePathContext.Provider value={() => true}>
          <InlineMd>{"see [`src/a.cpp`](src/b.cpp)"}</InlineMd>
        </ProsePathContext.Provider>
      </FileOpenContext.Provider>,
    );
    expect(container.querySelector(".file-ref .file-ref")).toBeNull();
    fireEvent.click(container.querySelector(".file-ref")!);
    expect(open.mock.calls).toEqual([["src/b.cpp"]]);
  });

  it("resolve ./ and ../ against the note that names them", () => {
    expect(refFrom("notes/release/docs-truth.md", "../ideas.md")).toBe("notes/ideas.md");
    expect(refFrom("notes/release/docs-truth.md", "./x.md")).toBe("notes/release/x.md");
    expect(refFrom("notes/release/docs-truth.md", "src/a.cpp")).toBe("src/a.cpp");
  });
});

describe("the notes view", () => {
  it("lists the notes as a tree, the archive closed, and shows one in full", async () => {
    const { container } = board();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    const tree = within(await screen.findByRole("tree", { name: "Notes" }));
    await tree.findByRole("treeitem", { name: /docs-truth\.md/ });
    expect(tree.getByRole("treeitem", { name: /_archive/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(requests.some((u) => u.includes("_archive"))).toBe(false);
    expect(requests.every((u) => u.startsWith("api/file?project=p1&path="))).toBe(true);

    fireEvent.click(tree.getByRole("treeitem", { name: /docs-truth\.md/ }));
    const shown = await preview();
    await within(shown).findByRole("heading", { name: "Docs truth" });
    // Its own links: ../ against the note, notes/ and the rest as the board reads them.
    fireEvent.click(within(shown).getByText("the ideas"));
    await screen.findByRole("heading", { name: "Ideas" });
    expect(container.querySelector(".bn-item.selected")!.textContent).toBe("ideas.md");
  });

  it("opens a path an objective names on the board, a line of code marked", async () => {
    const { container } = board();
    fireEvent.click(container.querySelector('[data-objective="release/docs"]')!);
    const detail = screen.getByRole("complementary", { name: "Docs truth" });
    const refs = [...detail.querySelectorAll(".file-ref")].map((e) => e.textContent);
    expect(refs).toEqual([
      "notes/release/docs-truth.md",
      "src/server/a.cpp:12",
      "notes/rules/cli.md",
      "src/server/a.cpp:2",
      "sched/batch.cpp",
      "notes/release/",
    ]);
    // A button holds no link: the dependency's title stays text.
    expect(detail.querySelector(".bp-ref .file-ref")).toBeNull();

    fireEvent.click(within(detail).getByText("src/server/a.cpp:12"));
    const shown = await preview();
    await waitFor(() => expect(shown.textContent).toContain("int b;"));
    expect(screen.getByRole("button", { name: "Notes" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".code-mark")).not.toBeNull();
    expect(opens).toEqual([]);
  });

  it("opens it in VS Code from VS Code's browser, and on the board when VS Code is not there", async () => {
    expect(inVSCode(VSCODE_UA)).toBe(true);
    expect(inVSCode(VSCODE_UA.replace("Code/", "Code - Insiders/"))).toBe(true);
    expect(inVSCode("Mozilla/5.0 (Windows NT 10.0) Chrome/138.0 Safari/537.36")).toBe(false);
    const { container } = board(VSCODE_UA);
    fireEvent.click(container.querySelector('[data-objective="release/docs"]')!);
    const detail = screen.getByRole("complementary", { name: "Docs truth" });
    fireEvent.click(within(detail).getByText("src/server/a.cpp:12"));
    await waitFor(() =>
      expect(opens).toEqual([{ project: "p1", path: "src/server/a.cpp", line: 12 }]),
    );
    expect(screen.getByRole("button", { name: "Objectives" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    editor = "down";
    fireEvent.click(within(detail).getByText("notes/release/docs-truth.md"));
    const shown = await preview();
    expect(
      within(shown).getByText("No VS Code window is connected: the file is shown here instead."),
    ).toBeTruthy();
  });

  it("shows a folder or a missing file on the board, saying why only when VS Code failed", async () => {
    const { container } = board(VSCODE_UA);
    const detail = objective(container);
    fireEvent.click(within(detail).getByText("notes/release/"));
    const folder = await screen.findByRole("region", { name: "release" });
    await within(folder).findByText("docs-truth.md");
    expect(container.querySelector(".bn-notice")).toBeNull();
    // A folder is not offered to VS Code from its view either.
    expect(within(folder).queryByRole("button", { name: "VS Code" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Objectives" }));
    fireEvent.click(within(objective(container)).getByText("notes/rules/cli.md"));
    await waitFor(() => expect(opens).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Objectives" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    editor = "offline";
    fireEvent.click(within(objective(container)).getByText("sched/batch.cpp"));
    const code = await preview();
    expect(within(code).getByText("Failed to fetch: the file is shown here instead.")).toBeTruthy();
    // Found under src/, and shown as it is there, only its start: bytes, not characters.
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "batch.cpp" }).querySelector(".bn-path")!.textContent,
      ).toBe("src/sched/batch.cpp"),
    );
    await screen.findByText("Showing the first 2.9 KB of 2.9 MB.");
  });

  it("offers what a path not there may have meant", async () => {
    const { container } = board();
    fireEvent.click(within(objective(container)).getByText("notes/release/docs-truth.md"));
    fireEvent.click(await within(await preview()).findByText("cli/format.md"));
    const missing = await screen.findByRole("region", { name: "format.md" });
    const choices = await within(missing).findByLabelText("Did you mean");
    fireEvent.click(within(choices).getByText("notes/rules/cli.md"));
    await screen.findByRole("heading", { name: "CLI rules" });
  });

  it("says when VS Code did not open the file from its view", async () => {
    board(VSCODE_UA);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /ideas\.md/ }));
    const shown = await preview();
    editor = "down";
    fireEvent.click(await within(shown).findByRole("button", { name: "VS Code" }));
    await within(shown).findByText("VS Code could not open it: No VS Code window is connected.");
  });

  it("links paths in the issues' notes but not in their rows", () => {
    const issues: IssueModules = [
      {
        id: "features",
        title: "Features",
        notes: "Hover lives in src/feature/hover.cpp.",
        objectives: [],
        issues: [
          {
            id: "10-01#1",
            state: "open",
            tags: [],
            text: "Breaks in src/feature/x.cpp",
            objectives: [],
          },
        ],
        groups: [],
        updatedAt: 0,
      },
    ];
    const { container } = board(undefined, issues);
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    const refs = [...container.querySelectorAll(".bp-main .file-ref")].map((e) => e.textContent);
    expect(refs).toEqual(["src/feature/hover.cpp"]);
    expect(container.querySelector(".bi-row .file-ref")).toBeNull();
  });

  it("tells a failed listing of the notes from no notes", async () => {
    broken.add("notes");
    board();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await screen.findByText("Permission denied");
  });

  it("closes the file with Escape, back where it was opened from", async () => {
    const { container } = board();
    fireEvent.click(within(objective(container)).getByText("notes/release/docs-truth.md"));
    await preview();
    // A link in the note keeps the way back.
    fireEvent.click(await screen.findByText("the ideas"));
    await screen.findByRole("heading", { name: "Ideas" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(container.querySelector(".bn-preview")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Docs truth" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Docs truth" })).toBeNull();
    expect(container.querySelector(".board-page")).not.toBeNull();

    // From the notes' own tree, it goes back to the tree.
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /ideas\.md/ }));
    await preview();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("tree", { name: "Notes" })).toBeTruthy();
  });

  it("shows the file clicked last when VS Code answers out of order", async () => {
    const gates: Array<() => void> = [];
    const real = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "api/open"
          ? new Promise<Response>((resolve) =>
              gates.push(() =>
                resolve(
                  new Response(JSON.stringify({ error: "VS Code did not answer" }), {
                    status: 503,
                  }),
                ),
              ),
            )
          : real(url, init),
      ),
    );
    const { container } = board(VSCODE_UA);
    const detail = objective(container);
    fireEvent.click(within(detail).getByText("notes/release/docs-truth.md"));
    fireEvent.click(within(detail).getByText("src/server/a.cpp:12"));
    await waitFor(() => expect(gates).toHaveLength(2));
    gates[1]();
    const shown = await preview();
    expect(shown.getAttribute("aria-label")).toBe("a.cpp");
    gates[0]();
    await new Promise((r) => setTimeout(r, 20));
    expect((await preview()).getAttribute("aria-label")).toBe("a.cpp");
  });

  it("takes a file found under another path for that path, in the tree and its links", async () => {
    FILES["notes/ideas.md"] = {
      ...(FILES["notes/ideas.md"] as object),
      content: "# Ideas\n\nSee rules/cli.md.\n",
    };
    try {
      board();
      fireEvent.click(screen.getByRole("button", { name: "Notes" }));
      fireEvent.click(await screen.findByRole("treeitem", { name: /ideas\.md/ }));
      fireEvent.click(await within(await preview()).findByText("rules/cli.md"));
      // Shown again under the path found: the one the tree and its links go by.
      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "cli.md" }).querySelector(".bn-path")!.textContent,
        ).toBe("notes/rules/cli.md"),
      );
      expect(document.querySelector(".bn-item.selected")!.getAttribute("title")).toBe(
        "notes/rules/cli.md",
      );
      fireEvent.click(
        await within(screen.getByRole("region", { name: "cli.md" })).findByText("the engine"),
      );
      await waitFor(() =>
        expect(requests.at(-1)).toBe(
          `api/file?project=p1&path=${encodeURIComponent("notes/rules/engine.md")}`,
        ),
      );
    } finally {
      FILES["notes/ideas.md"] = { ...(FILES["notes/ideas.md"] as object), content: "# Ideas\n" };
    }
  });

  it("drops VS Code's late answer once the user went on", async () => {
    const gates: Array<() => void> = [];
    const real = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "api/open"
          ? new Promise<Response>((resolve) =>
              gates.push(() =>
                resolve(
                  new Response(JSON.stringify({ error: "VS Code did not answer" }), {
                    status: 503,
                  }),
                ),
              ),
            )
          : real(url, init),
      ),
    );
    const { container } = board(VSCODE_UA);
    fireEvent.click(within(objective(container)).getByText("src/server/a.cpp:12"));
    await waitFor(() => expect(gates).toHaveLength(1));
    fireEvent.keyDown(document.body, { key: "Escape" });
    gates[0]();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".bn-preview")).toBeNull();
    expect(screen.getByRole("button", { name: "Objectives" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("comes back to the details where they were scrolled to", async () => {
    const { container } = board();
    const detail = objective(container);
    detail.scrollTop = 500;
    fireEvent.click(within(detail).getByText("src/server/a.cpp:12"));
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("complementary", { name: "Docs truth" }).scrollTop).toBe(500);
  });

  it("links the issues a note names", async () => {
    FILES["notes/ideas.md"] = {
      ...(FILES["notes/ideas.md"] as object),
      content: "# Ideas\n\nSee 10-01#1.\n",
    };
    const issues: IssueModules = [
      {
        id: "features",
        title: "Features",
        objectives: [],
        issues: [{ id: "10-01#1", state: "open", tags: [], text: "Hover breaks", objectives: [] }],
        groups: [],
        updatedAt: 0,
      },
    ];
    try {
      board(undefined, issues);
      fireEvent.click(screen.getByRole("button", { name: "Notes" }));
      fireEvent.click(await screen.findByRole("treeitem", { name: /ideas\.md/ }));
      fireEvent.click(await within(await preview()).findByText("10-01#1"));
      expect(screen.getByRole("button", { name: /^Issues/ }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    } finally {
      FILES["notes/ideas.md"] = { ...(FILES["notes/ideas.md"] as object), content: "# Ideas\n" };
    }
  });
});
