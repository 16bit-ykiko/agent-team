import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { BoardPage, type SessionInfo } from "../src/project/BoardPage";
import { layout, reach, relations, stage, matches } from "../src/project/board";
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

// A slice of a real board: prerequisites across areas, work in progress,
// things put off and dropped, open and settled decisions.
const objectives: Objective[] = [
  o("foundation/identity", {
    title: "Declaration identity",
    priority: "high",
    tasks: [
      { id: "t1", text: "entity hash", state: "done" },
      { id: "t2", text: "content closure", state: "doing", session: "w1" },
      { id: "t3", text: "old USR path", state: "dropped" },
    ],
    decisions: [{ id: "d1", question: "hash width?", outcome: "64 bits" }],
    sessions: ["w1"],
    context: "Half of the **index** uses it.",
  }),
  o("index/name-ranges", {
    title: "Multi-token name ranges",
    dependsOn: ["foundation/identity"],
    decisions: [{ id: "d1", question: "store ranges or recompute?" }],
  }),
  o("cli/refactor", {
    title: "Rename across the project",
    dependsOn: ["index/name-ranges", "foundation/identity", "cli/edits"],
  }),
  o("infra/lto", {
    title: "LTO build",
    status: "later",
    priority: "low",
    reason: "after the toolchain bump",
  }),
  o("infra/codec", { title: "Drop codec", status: "dropped", reason: "not worth it" }),
  o("foundation/paths", { title: "Canonical paths", status: "done" }),
];

const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [...objectives, { id: "infra/broken", error: "Unexpected character at row 2" }],
};

const sessions = new Map<string, SessionInfo>([["w1", { name: "identity", state: "working" }]]);

function page(p: Project = project) {
  const props = {
    onClose: vi.fn(),
    onOpenSession: vi.fn(),
    onAskLead: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(<BoardPage project={p} sessions={sessions} {...props} />);
  const cards = () =>
    [...utils.container.querySelectorAll(".bp-card .bp-card-title")].map((e) => e.textContent);
  return { ...utils, ...props, cards };
}

describe("board relations", () => {
  it("know what blocks what, where each stands and how deep it sits", () => {
    const rel = relations(objectives);
    expect(rel.get("cli/refactor")).toEqual({
      blockedBy: ["index/name-ranges", "foundation/identity"],
      unblocks: [],
      dropped: [],
      missing: ["cli/edits"],
    });
    expect(rel.get("foundation/identity")!.unblocks).toEqual(["index/name-ranges", "cli/refactor"]);
    expect(stage(objectives[0], rel.get("foundation/identity")!)).toBe("in progress");
    expect(stage(objectives[1], rel.get("index/name-ranges")!)).toBe("blocked");
    expect(stage(objectives[3], rel.get("infra/lto")!)).toBeNull();
    expect(layout(objectives.slice(0, 3)).columns.map((c) => c.map((x) => x.id))).toEqual([
      ["foundation/identity"],
      ["index/name-ranges"],
      ["cli/refactor"],
    ]);
    expect([...reach(objectives, "cli/refactor", "up")].sort()).toEqual([
      "foundation/identity",
      "index/name-ranges",
    ]);
    expect([...reach(objectives, "foundation/identity", "down")].sort()).toEqual([
      "cli/refactor",
      "index/name-ranges",
    ]);
    expect(
      matches(objectives[0], {
        area: null,
        statuses: ["active"],
        search: "closure",
        archive: false,
      }),
    ).toBe(true);
  });

  it("lay out a hand-made cycle without hanging", () => {
    const loop = [o("a/x", { dependsOn: ["a/y"] }), o("a/y", { dependsOn: ["a/x"] })];
    expect(layout(loop).columns.flat()).toHaveLength(2);
  });
});

describe("BoardPage", () => {
  it("shows active and later work by area, most pressing first, and unreadable files", () => {
    const { cards, container, getByText } = page();
    expect(cards()).toEqual([
      "Rename across the project",
      "Declaration identity",
      "Multi-token name ranges",
      "LTO build",
    ]);
    expect([...container.querySelectorAll(".bp-group-title")].map((e) => e.textContent)).toEqual([
      "cli",
      "foundation",
      "index",
      "infra",
    ]);
    expect(getByText("infra/broken.toml")).toBeTruthy();
    expect(container.querySelector(".bp-summary")!.textContent).toBe("3 active · 1 later · 1 done");
  });

  it("puts the state of each card on its face", () => {
    const { container } = page();
    const card = (title: string) =>
      [...container.querySelectorAll(".bp-card")].find(
        (c) => c.querySelector(".bp-card-title")!.textContent === title,
      )!;
    const identity = within(card("Declaration identity") as HTMLElement);
    expect(identity.getByText("in progress")).toBeTruthy();
    expect(identity.getByTitle("1 of 2 tasks done")).toBeTruthy();
    expect(identity.getByText("high")).toBeTruthy();
    expect(
      within(card("Multi-token name ranges") as HTMLElement).getByText("1 to decide"),
    ).toBeTruthy();
    expect(
      within(card("Rename across the project") as HTMLElement).getByText("blocked by 2"),
    ).toBeTruthy();
    expect(
      within(card("LTO build") as HTMLElement).getByText("after the toolchain bump"),
    ).toBeTruthy();
  });

  it("filters by area, status and search", () => {
    const { cards, getByPlaceholderText, container } = page();
    const nav = within(container.querySelector(".bp-nav") as HTMLElement);
    fireEvent.click(nav.getByRole("button", { name: /^infra/ }));
    expect(cards()).toEqual(["LTO build"]);
    fireEvent.click(nav.getByRole("button", { name: /^Dropped/ }));
    expect(cards()).toEqual(["LTO build", "Drop codec"]);
    fireEvent.click(nav.getByRole("button", { name: /^All areas/ }));
    fireEvent.change(getByPlaceholderText("Search objectives…"), { target: { value: "closure" } });
    expect(cards()).toEqual(["Declaration identity"]);
    fireEvent.change(getByPlaceholderText("Search objectives…"), { target: { value: "zzz" } });
    expect(container.querySelector(".bp-empty")!.textContent).toBe("Nothing matches.");
  });

  it("opens an objective in full and walks its dependencies", () => {
    const { getByText, container, onOpenSession, onAskLead } = page();
    fireEvent.click(getByText("Rename across the project"));
    const detail = () => within(container.querySelector(".bp-detail") as HTMLElement);
    expect(detail().getByRole("heading", { name: "Rename across the project" })).toBeTruthy();
    // Prerequisites: two blocking, one that is not an objective.
    const refs = [...container.querySelectorAll(".bp-detail .bp-ref")];
    expect(refs.map((r) => [r.textContent, r.className.includes("blocking")])).toEqual([
      ["Multi-token name ranges", true],
      ["Declaration identity", true],
      ["cli/edits", false],
    ]);
    fireEvent.click(detail().getByText("Declaration identity"));
    expect(detail().getByText("Tasks · 1/2")).toBeTruthy();
    expect(detail().getByText("Needed by")).toBeTruthy();
    expect(detail().getByText("hash width?")).toBeTruthy();
    expect(detail().getByText("64 bits")).toBeTruthy();
    expect(container.querySelector(".bp-detail strong")!.textContent).toBe("index");
    fireEvent.click(container.querySelector(".bp-detail .bp-session")!);
    expect(onOpenSession).toHaveBeenCalledWith("w1");
    fireEvent.click(detail().getByText("Ask the lead"));
    expect(onAskLead).toHaveBeenCalledWith("foundation/identity");
  });

  it("draws the dependency graph in columns with an edge per prerequisite", () => {
    const { getByRole, container } = page();
    fireEvent.click(getByRole("button", { name: "Dependencies" }));
    const columns = [...container.querySelectorAll(".bp-column")].map((c) =>
      [...c.querySelectorAll(".bp-node-title")].map((n) => n.textContent),
    );
    expect(columns).toEqual([
      ["Declaration identity"],
      ["Multi-token name ranges"],
      ["Rename across the project"],
      ["LTO build"],
    ]);
    expect(container.querySelector(".bp-independent .bp-node-title")!.textContent).toBe(
      "LTO build",
    );
    expect(container.querySelectorAll(".bp-edges path")).toHaveLength(3);
    const nodeOf = (id: string) =>
      [...container.querySelectorAll<HTMLElement>(".bp-node")].find(
        (n) => n.dataset.objective === id,
      )!;
    fireEvent.click(nodeOf("index/name-ranges"));
    const cls = (id: string) => nodeOf(id).className;
    expect(cls("foundation/identity")).toContain(" up");
    expect(cls("cli/refactor")).toContain(" down");
    expect(cls("infra/lto")).toContain(" dim");
  });

  it("steps back on Escape: details first, then the page", () => {
    const { getByText, container, onClose } = page();
    fireEvent.click(getByText("LTO build"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".bp-detail")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("explains an empty board", () => {
    const { container } = page({ ...project, objectives: [] });
    expect(container.querySelector(".bp-empty")!.textContent).toContain("No objectives yet");
  });
});

describe("BoardPage header", () => {
  it("renames on Enter, keeps the name on Escape and ignores an IME Enter", () => {
    const { getByTitle, getByLabelText, onRename, onClose } = page();
    fireEvent.click(getByTitle("Rename"));
    fireEvent.keyDown(getByLabelText("Project name"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(getByTitle("Rename"));
    const input = getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " clice next " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("clice next");
  });

  it("asks to delete the project and closes on the backdrop", () => {
    const { getByText, container, onDelete, onClose } = page();
    // At the foot of the filters, away from Close.
    expect(getByText("Delete project").parentElement!.className).toBe("bp-nav");
    expect(container.querySelector(".bp-head")!.textContent).not.toContain("Delete");
    fireEvent.click(getByText("Delete project"));
    expect(onDelete).toHaveBeenCalled();
    fireEvent.click(container.querySelector(".board-page")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".board-overlay")!);
    expect(onClose).toHaveBeenCalled();
  });
});
