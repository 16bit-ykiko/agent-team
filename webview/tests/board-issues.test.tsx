// The board page's issues: the view by module and group, its filters, and
// the links between issues and objectives both ways.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within, screen } from "@testing-library/react";
import { BoardPage } from "../src/project/BoardPage";
import { MdBlock } from "../src/chat/markdown";
import { issueIdPattern, issueSummary } from "../src/project/issues";
import type { Issue, IssueModule, IssueModules, Objective, Project } from "../src/state/useServer";

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
    o("service/release-fixes", {
      title: "Release fixes",
      context: "Fix 10-06#1 first, then `10-06#1` stays code; 10-06#14 is no issue.",
      tasks: [{ id: "t1", text: "修10-06#1：CUDA headers", state: "todo" }],
    }),
    o("index/hosts", { title: "Hosts" }),
  ],
};

const issues: IssueModules = [
  {
    id: "02-hosting",
    title: "宿主选择与依赖图（hosting.cpp、dependency_graph.cpp）",
    objectives: [],
    issues: [
      {
        id: "10-07#5",
        state: "accepted",
        tags: [],
        text: "One include tree per host.",
        objectives: ["index/hosts"],
      },
    ],
    groups: [
      {
        id: "chain",
        title: "Host chains",
        notes: "Startup scan mixes configurations.\n\nRe-run on a75797dc.",
        objectives: ["index/hosts"],
        issues: [
          {
            id: "09-23#12",
            state: "open",
            evidence: "R",
            tags: ["部分"],
            text: "Header picks a.cpp as its host.\n\nwhere: `dependency_graph.cpp:175`",
            objectives: [],
          },
          {
            id: "h3r2#1",
            state: "decision",
            evidence: "H",
            tags: [],
            text: "Edges lost when b.cpp comes first.",
            objectives: [],
          },
        ],
      },
    ],
    updatedAt: 0,
  },
  {
    id: "14-features",
    title: "Features (src/feature)",
    objectives: ["service/release-fixes"],
    issues: [
      {
        id: "10-06#1",
        state: "open",
        evidence: "V",
        tags: ["崩溃"],
        text: "CUDA from the Ubuntu packages: every .cu is wrong.",
        objectives: [],
      },
    ],
    groups: [],
    updatedAt: 0,
  },
  { id: "03-paths", error: "Unexpected character at row 2" },
];

function page(p: Project = project, modules: IssueModules = issues) {
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(<BoardPage project={p} issues={modules} sessions={new Map()} {...props} />);
  const rows = () =>
    [...utils.container.querySelectorAll(".bi-row .bp-id")].map((e) => e.textContent);
  const toIssues = () => fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
  const nav = () => within(screen.getByRole("navigation", { name: "Issue filters" }));
  return { ...utils, ...props, rows, toIssues, nav };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("the issues view", () => {
  it("shows the open and to-decide issues by module and group, with the group's notes", () => {
    const { rows, toIssues, container } = page();
    expect(screen.getByRole("button", { name: /^Issues/ }).textContent).toBe("Issues3");
    toIssues();
    expect(rows()).toEqual(["09-23#12", "h3r2#1", "10-06#1"]);
    expect(container.querySelector(".bp-summary")!.textContent).toBe(
      "2 open · 1 to decide · 1 accepted",
    );
    const titles = [...container.querySelectorAll(".bp-group-title")].map((e) => e.textContent);
    expect(titles).toEqual([
      "宿主选择与依赖图（hosting.cpp、dependency_graph.cpp）",
      "Features (src/feature)",
    ]);
    expect(container.querySelector(".bi-group-title")!.textContent).toBe("Host chains");
    expect(container.querySelector(".bi-group-notes")!.textContent).toBe(
      "Startup scan mixes configurations.",
    );
    const row = container.querySelector('[data-issue="09-23#12"]')!;
    expect(row.querySelector(".bi-evidence")!.textContent).toBe("R");
    expect(row.querySelector(".bi-tag")!.textContent).toBe("部分");
    expect(row.querySelector(".bi-row-text")!.textContent).toBe("Header picks a.cpp as its host.");
    expect(container.querySelector('[data-issue="h3r2#1"] .bp-pill')!.textContent).toBe(
      "To decide",
    );
    expect(container.querySelector(".bp-broken")!.textContent).toContain("03-paths.toml");
  });

  it("filters by module, state, evidence, tag and words", () => {
    const { rows, toIssues, nav } = page();
    toIssues();
    const areas = nav()
      .getAllByRole("button")
      .filter((b) => b.classList.contains("bp-area"))
      .map((b) => b.textContent);
    expect(areas).toEqual(["All modules3", "宿主选择与依赖图2", "Features1"]);

    fireEvent.click(nav().getByRole("button", { name: /^Accepted/ }));
    expect(rows()).toEqual(["10-07#5", "09-23#12", "h3r2#1", "10-06#1"]);
    fireEvent.click(nav().getByRole("button", { name: /^Features/ }));
    expect(rows()).toEqual(["10-06#1"]);
    fireEvent.click(nav().getByRole("button", { name: /^All modules/ }));

    fireEvent.click(nav().getByRole("button", { name: /^H / }));
    expect(rows()).toEqual(["h3r2#1"]);
    fireEvent.click(nav().getByRole("button", { name: /^H / }));
    fireEvent.click(nav().getByRole("button", { name: /^崩溃/ }));
    expect(rows()).toEqual(["10-06#1"]);
    fireEvent.click(nav().getByRole("button", { name: /^崩溃/ }));

    fireEvent.change(screen.getByPlaceholderText("Search issues…"), {
      target: { value: "B.CPP" },
    });
    expect(rows()).toEqual(["h3r2#1"]);
  });

  it("opens an issue in full, and goes from it to the objectives it is linked to", () => {
    const { toIssues, container } = page();
    toIssues();
    fireEvent.click(container.querySelector('[data-issue="09-23#12"]')!);
    const detail = within(screen.getByRole("complementary", { name: "Issue 09-23#12" }));
    expect(detail.getByText("R · Reproduced by a script")).toBeTruthy();
    expect(container.querySelector(".bi-where")!.textContent).toBe(
      "宿主选择与依赖图（hosting.cpp、dependency_graph.cpp） › Host chains",
    );
    expect(container.querySelector(".bp-detail .bp-md")!.textContent).toContain(
      "where: dependency_graph.cpp:175",
    );
    // Linked through its group.
    fireEvent.click(detail.getByRole("button", { name: "Hosts" }));
    expect(screen.getByRole("complementary", { name: "Hosts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Objectives" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("steps back with Escape: the search, then the issue, then the page", () => {
    const { toIssues, container, onClose } = page();
    toIssues();
    const search = screen.getByPlaceholderText("Search issues…");
    fireEvent.change(search, { target: { value: "cuda" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    fireEvent.click(container.querySelector('[data-issue="10-06#1"]')!);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(container.querySelector(".bp-detail")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when there are none yet", () => {
    page(project, []);
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    expect(screen.getByText(/No issues yet/)).toBeTruthy();
  });
});

describe("issues on the objectives' side", () => {
  it("counts an objective's open issues on its card", () => {
    const { container } = page();
    const card = (id: string) => container.querySelector(`[data-objective="${id}"]`)!;
    expect(card("index/hosts").querySelector(".bi-count")!.textContent).toBe("2 issues");
    expect(card("service/release-fixes").querySelector(".bi-count")!.textContent).toBe("1 issue");
  });

  it("lists the issues linked to an objective, and opens one", () => {
    const { container } = page();
    fireEvent.click(container.querySelector('[data-objective="index/hosts"]')!);
    const detail = within(screen.getByRole("complementary", { name: "Hosts" }));
    expect(detail.getByText("Issues · 2 open")).toBeTruthy();
    expect(detail.getByText("1 accepted, not to be fixed.")).toBeTruthy();
    fireEvent.click(detail.getByRole("button", { name: /^h3r2#1/ }));
    expect(screen.getByRole("complementary", { name: "Issue h3r2#1" })).toBeTruthy();
  });

  it("links the issue ids named in an objective's text, not in code nor in a longer id", () => {
    const { container } = page();
    fireEvent.click(container.querySelector('[data-objective="service/release-fixes"]')!);
    const detail = screen.getByRole("complementary", { name: "Release fixes" });
    const links = [...detail.querySelectorAll(".issue-ref")].map((e) => e.textContent);
    // Once in the context, once in the task, right after Chinese.
    expect(links).toEqual(["10-06#1", "10-06#1"]);
    expect(detail.querySelector(".bp-md code")!.textContent).toBe("10-06#1");
    fireEvent.click(detail.querySelector(".issue-ref")!);
    expect(screen.getByRole("complementary", { name: "Issue 10-06#1" })).toBeTruthy();
  });

  it("shows an issue the filter hides when it is opened from an objective", () => {
    const { container, nav } = page();
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    fireEvent.click(nav().getByRole("button", { name: /^Features/ }));
    fireEvent.click(screen.getByRole("button", { name: "Objectives" }));
    fireEvent.click(container.querySelector('[data-objective="index/hosts"]')!);
    fireEvent.click(screen.getByRole("button", { name: /^h3r2#1/ }));
    expect(container.querySelector('[data-issue="h3r2#1"]')!.classList).toContain("selected");
  });
});

describe("issue ids in text", () => {
  it("match only where they stand alone", () => {
    const pattern = issueIdPattern(["10-06#1", "F7", "h3r2#1"])!;
    const found = (s: string) => [...s.matchAll(pattern)].map((m) => m[0]);
    expect(found("见10-06#1、h3r2#1 和 F7。")).toEqual(["10-06#1", "h3r2#1", "F7"]);
    expect(found("10-06#14 F71 x10-06#1 09-10-06#1")).toEqual([]);
    expect(issueIdPattern([])).toBeNull();
  });

  it("are left alone in markdown outside the board", () => {
    const { container } = render(<MdBlock>{"See 10-06#1."}</MdBlock>);
    expect(container.querySelector(".issue-ref")).toBeNull();
  });

  it("summarise an issue by its first paragraph", () => {
    expect(issueSummary("First line\nsame paragraph.\n\nSecond.")).toBe(
      "First line same paragraph.",
    );
  });
});

describe("issue view edge cases from review", () => {
  const mod = (id: string, over: Partial<IssueModule> = {}): IssueModule => ({
    id,
    title: id,
    objectives: [],
    issues: [],
    groups: [],
    updatedAt: 0,
    ...over,
  });
  const issue = (id: string, over: Partial<Issue> = {}): Issue => ({
    id,
    state: "open",
    tags: [],
    text: `text of ${id}`,
    objectives: [],
    ...over,
  });
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  const rows = () => [...document.querySelectorAll(".bi-row .bp-id")].map((e) => e.textContent);
  const nav = () => within(screen.getByRole("navigation", { name: "Issue filters" }));

  it("leaves the issue opened from an objective in view, not scrolled back to the top", () => {
    const calls: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push(
        `into:${(this as HTMLElement).dataset.issue ?? (this as HTMLElement).dataset.objective}`,
      );
    };
    Element.prototype.scrollTo = vi.fn(() => void calls.push("top"));
    const { container } = page();
    fireEvent.click(container.querySelector('[data-objective="service/release-fixes"]')!);
    calls.splice(0);
    fireEvent.click(
      screen.getByRole("complementary", { name: "Release fixes" }).querySelector(".issue-ref")!,
    );
    expect(calls.at(-1)).toBe("into:10-06#1");
  });

  it("keeps a picked tag on show, to be cleared, once no issue has it", () => {
    const one = [mod("m", { issues: [issue("a", { tags: ["崩溃"] }), issue("b")] })];
    const { rerender } = render(
      <BoardPage project={project} issues={one} sessions={new Map()} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    fireEvent.click(nav().getByRole("button", { name: /^崩溃/ }));
    expect(rows()).toEqual(["a"]);
    rerender(
      <BoardPage
        project={project}
        issues={[mod("m", { issues: [issue("b")] })]}
        sessions={new Map()}
        {...props}
      />,
    );
    const chip = nav().getByRole("button", { name: /^崩溃/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(rows()).toEqual(["b"]);
  });

  it("shows a module's notes over its issues and with each of them", () => {
    const m = [
      mod("m", {
        title: "Paths",
        notes: "All paths go through one table.\n\nMore.",
        issues: [issue("a")],
      }),
    ];
    const { container } = render(
      <BoardPage project={project} issues={m} sessions={new Map()} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    expect(container.querySelector(".bi-module-notes")!.textContent).toBe(
      "All paths go through one table.",
    );
    fireEvent.click(container.querySelector('[data-issue="a"]')!);
    expect(screen.getByRole("complementary", { name: "Issue a" }).textContent).toContain("More.");
  });

  it("counts on each filter the rows it gives", () => {
    const m = [
      mod("m", {
        issues: [
          issue("a", { evidence: "H" }),
          issue("b", { evidence: "H", state: "accepted" }),
          issue("c", { evidence: "H", state: "accepted" }),
        ],
      }),
    ];
    render(<BoardPage project={project} issues={m} sessions={new Map()} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    const h = nav().getByRole("button", { name: /^H / });
    expect(h.textContent).toBe("H 1");
    fireEvent.click(h);
    expect(rows()).toEqual(["a"]);
  });

  it("shows an id that is in two modules once, and says so", () => {
    const m = [
      mod("one", { issues: [issue("F7")] }),
      mod("two", { issues: [issue("F7", { text: "other" })] }),
    ];
    const { container } = render(
      <BoardPage project={project} issues={m} sessions={new Map()} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    expect(rows()).toEqual(["F7"]);
    expect(container.querySelector(".bp-broken")!.textContent).toContain("F7");
  });

  it("links the issues an issue's text names", () => {
    const m = [mod("m", { issues: [issue("a", { text: "Same root as b#1." }), issue("b#1")] })];
    const { container } = render(
      <BoardPage project={project} issues={m} sessions={new Map()} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    fireEvent.click(container.querySelector('[data-issue="a"]')!);
    fireEvent.click(
      screen.getByRole("complementary", { name: "Issue a" }).querySelector(".issue-ref")!,
    );
    expect(screen.getByRole("complementary", { name: "Issue b#1" })).toBeTruthy();
  });

  it("brings an objective hidden by the board's filters back when an issue opens it", () => {
    const p = {
      ...project,
      objectives: [o("x/done", { title: "Done one", status: "done" as const })],
    };
    const m = [mod("m", { issues: [issue("a", { objectives: ["x/done"] })] })];
    const { container } = render(
      <BoardPage project={p} issues={m} sessions={new Map()} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Issues/ }));
    fireEvent.click(container.querySelector('[data-issue="a"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Done one" }));
    expect(container.querySelector('[data-objective="x/done"]')!.classList).toContain("selected");
  });
});

describe("issue text edge cases from review", () => {
  it("never breaks markdown over a bad issue link, nor makes one outside the board", () => {
    const { container } = render(<MdBlock>{"[x](#issue:%E0) and [y](#issue:F7)"}</MdBlock>);
    expect(container.querySelector(".issue-ref")).toBeNull();
    expect(container.textContent).toContain("x and y");
  });

  it("summarise an issue that opens with code by its code", () => {
    expect(issueSummary("```cpp\nint x;\n\nint y;\n```\n\nbody")).toBe("int x;");
    expect(issueSummary("## Repro\n\nSteps")).toBe("Repro");
  });

  it("match an id followed by a dash and more as part of something else, and no ids too short to tell", () => {
    const pattern = issueIdPattern(["F7", "1"])!;
    expect([..."F7-A F7. 1 x".matchAll(pattern)].map((m) => m[0])).toEqual(["F7"]);
  });
});
