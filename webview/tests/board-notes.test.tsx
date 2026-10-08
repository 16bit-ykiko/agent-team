// The board's notes view and the files its text names: paths written in
// prose become links, a link opens the file on the board (or in VS Code when
// the panel is open in VS Code's own browser), and a note's own links
// resolve against it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, within, waitFor } from "@testing-library/react";
import { BoardPage } from "../src/project/BoardPage";
import { MdBlock, ProsePathContext, prosePaths } from "../src/chat/markdown";
import { FileOpenContext } from "../src/chat/fileRef";
import { inVSCode, refFrom } from "../src/project/NotesView";
import type { Objective, Project } from "../src/state/useServer";

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
      tasks: [{ id: "t1", text: "规则进 notes/rules/cli.md", state: "todo" }],
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
  "notes/release/docs-truth.md": {
    kind: "text",
    path: "/data/notes/release/docs-truth.md",
    size: 40,
    content: "# Docs truth\n\nSee [the ideas](../ideas.md) and notes/rules/cli.md.\n",
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
let editorUp: boolean;

beforeEach(() => {
  requests = [];
  opens = [];
  editorUp = true;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      requests.push(url);
      if (url === "api/open") {
        opens.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(new Response("{}", { status: editorUp ? 200 : 503 }));
      }
      const q = new URL(url, "http://x").searchParams;
      const body = q.get("project") === "p1" ? FILES[q.get("path") ?? ""] : undefined;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { error: "No such file or directory" }), {
          status: body ? 200 : 404,
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function board(ua?: string) {
  if (ua) vi.stubGlobal("navigator", { ...navigator, userAgent: ua });
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  return render(<BoardPage project={project} sessions={new Map()} {...props} />);
}
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
  });

  it("link only where the board turns them on", () => {
    const open = vi.fn();
    const text = "见 notes/ideas.md。";
    const { container, rerender } = render(<MdBlock>{text}</MdBlock>);
    expect(container.querySelector(".file-ref")).toBeNull();
    rerender(
      <FileOpenContext.Provider value={open}>
        <ProsePathContext.Provider value={true}>
          <MdBlock>{text}</MdBlock>
        </ProsePathContext.Provider>
      </FileOpenContext.Provider>,
    );
    fireEvent.click(container.querySelector(".file-ref")!);
    expect(open).toHaveBeenCalledWith("notes/ideas.md");
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

    editorUp = false;
    fireEvent.click(within(detail).getByText("notes/release/docs-truth.md"));
    const shown = await preview();
    expect(within(shown).getByText(/VS Code is not connected/)).toBeTruthy();
  });

  it("closes the file with Escape, then the page", async () => {
    const { container } = board();
    fireEvent.click(container.querySelector('[data-objective="release/docs"]')!);
    fireEvent.click(
      within(screen.getByRole("complementary", { name: "Docs truth" })).getByText(
        "notes/release/docs-truth.md",
      ),
    );
    await preview();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(container.querySelector(".bn-preview")).toBeNull();
    expect(container.querySelector(".board-page")).not.toBeNull();
  });
});
