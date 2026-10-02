import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, renderHook, act } from "@testing-library/react";
import { groupWorkspaces } from "../src/sidebar/groups";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import { MessageItem, chipLabelFor } from "../src/chat/messages";
import { CreateWorkspaceDialog } from "../src/workspace/dialogs";
import { useServer, type Message, type Project, type Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";
import css from "../src/styles.css?raw";

const NOW = 1_800_000_000_000;

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: "/repo",
  git: null,
  pr: null,
  agents: [],
  messages: [],
  createdAt: NOW - 5000,
  lastMessageAt: NOW - 5000,
  ...over,
});

const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: NOW - 10_000,
  objectives: [],
};

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 4000,
});
const worker = ws("w1", {
  name: "modules",
  cwd: "/wt/clice-modules",
  projectLink: { projectId: "p1", role: "worker" },
  lastMessageAt: NOW - 1000,
});

const msgOf = (id: string): Message => ({
  id,
  kind: "agent",
  agentId: "a",
  content: "x",
  timestamp: NOW,
  status: "done",
});

describe("project groups", () => {
  it("fold a project's sessions under it wherever they work, lead first, projects on top", () => {
    const groups = groupWorkspaces([ws("other", { lastMessageAt: NOW }), worker, lead], [project]);
    expect(groups.map((g) => g.label)).toEqual(["clice", "repo"]);
    expect(groups[0].project).toBe(project);
    expect(groups[0].workspaces.map((w) => w.id)).toEqual(["lead", "w1"]);
  });

  const sidebarProps = (): SidebarProps => ({
    workspaces: [lead, worker],
    projects: [project],
    activeWsId: "lead",
    connected: true,
    groupOverrides: {},
    seenCounts: {},
    finishedStatus: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    accounts: [],
    defaultAccount: null,
    now: NOW,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onToggleGroup: vi.fn(),
    onSearchChange: vi.fn(),
    onJump: vi.fn(),
    onCreate: vi.fn(),
    onCreateIn: vi.fn(),
    onReplayDemo: vi.fn(),
    onDebugSnapshot: vi.fn(),
    onPurgeArchived: vi.fn(),
    onSetDefaultAccount: vi.fn(),
    onDeleteProject: vi.fn(),
  });

  it("stand for their lead: the project's row opens it, and it is not listed again", () => {
    const props = sidebarProps();
    const { container } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-group-project")!;
    expect(header.querySelector(".ws-group-label")!.textContent).toBe("clice");
    expect(header.className).toContain("active");
    fireEvent.click(header.querySelector('[title="New session in clice"]')!);
    expect(props.onCreateIn).toHaveBeenCalledWith("/repo/clice");
    const names = [...container.querySelectorAll(".task-name-text")].map((e) => e.textContent);
    expect(names).toEqual(["modules"]);
    // Unfolded, its sessions are in view: no count of them.
    expect(header.querySelector(".ws-group-count")).toBeNull();
    fireEvent.click(header);
    expect(props.onSelect).toHaveBeenCalledWith("lead");
    expect(props.onToggleGroup).not.toHaveBeenCalled();
  });

  it("keep a project's row short: a count only when folded, no board, the branch only off main", () => {
    const git = (branch: string, dirty: number) => ({ branch, dirty, ahead: 0, behind: 0 });
    const props = sidebarProps();
    const { container, rerender } = render(
      <Sidebar {...props} groupOverrides={{ "project:p1": false }} />,
    );
    const header = () => container.querySelector(".ws-group-project")!;
    expect(header().querySelector(".ws-group-count")!.textContent).toBe("1");
    // The board opens from the chat header of any of its sessions.
    expect(header().querySelector('[title^="Objectives"]')).toBeNull();
    const branch = (b: string, dirty: number) => {
      rerender(<Sidebar {...props} workspaces={[{ ...lead, git: git(b, dirty) }, worker]} />);
      return header().querySelector(".ws-group-branch")?.textContent ?? null;
    };
    expect(branch("main", 0)).toBeNull();
    expect(branch("master", 0)).toBeNull();
    expect(branch("main", 2)).toBe("●");
    expect(branch("feat/x", 2)).toBe("feat/x●");
    // On touch, only the open session's project offers a new session.
    expect(header().className).toContain("current");
    rerender(<Sidebar {...props} activeWsId={null} />);
    expect(header().className).not.toContain("current");
  });

  it("offer no arrow while the lead has no sessions under it", () => {
    const props = { ...sidebarProps(), workspaces: [lead] };
    const { container, queryByLabelText } = render(<Sidebar {...props} />);
    expect(queryByLabelText("Fold clice")).toBeNull();
    expect(container.querySelector(".ws-group-project .events-toggle")!.textContent).toBe("");
  });

  it("fold the project's sessions from the arrow only", () => {
    const props = sidebarProps();
    const { getByLabelText } = render(<Sidebar {...props} />);
    fireEvent.click(getByLabelText("Fold clice"));
    expect(props.onToggleGroup).toHaveBeenCalledWith("project:p1", false);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("mark a worker waiting for the user's reply, until it runs again or is open", () => {
    const waiting = { ...worker, awaitsUser: true };
    const working = {
      ...waiting,
      agents: [{ id: "a", name: "A", model: "m", avatar: "", color: "#fff", isDefault: true }].map(
        (a) => ({ ...a, busy: true, state: "working" as const }),
      ),
    };
    const tag = (w: Workspace, activeWsId = "lead") =>
      render(
        <Sidebar {...sidebarProps()} workspaces={[lead, w]} activeWsId={activeWsId} />,
      ).container.querySelector(".task-item .awaits-tag");
    expect(tag(waiting)?.textContent).toBe("your turn");
    expect(tag(waiting)?.getAttribute("title")).toBe("Waiting for your reply");
    expect(tag(worker)).toBeNull();
    expect(tag(working)).toBeNull();
    expect(tag(waiting, "w1")).toBeNull();
  });

  it("cut a long session name, not the time or the marks after it, and keep it whole in its title", () => {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.appendChild(sheet);
    try {
      const long =
        "fix the wake-up time the CLI rounds up to the minute so the panel shows it early";
      const { container } = render(
        <Sidebar
          {...sidebarProps()}
          workspaces={[lead, { ...worker, name: long, awaitsUser: true }]}
        />,
      );
      const row = container.querySelector(".task-name-text")!;
      // A flex row cuts no text of its own: the name is a box that can.
      expect([...row.childNodes].map((n) => n.nodeName)).toEqual(["SPAN", "SPAN"]);
      const name = row.querySelector(".clip")!;
      expect(name.textContent).toBe(long);
      expect(name.getAttribute("title")).toBe(long);
      const style = getComputedStyle(name);
      expect([style.overflow, style.textOverflow, style.whiteSpace, style.minWidth]).toEqual([
        "hidden",
        "ellipsis",
        "nowrap",
        "0px",
      ]);
      expect(getComputedStyle(row.querySelector(".awaits-tag")!).flexShrink).toBe("0");
      // The time and × lie over the name's end, shown on hover: nothing
      // moves, and the × stays in the keyboard's reach.
      const hover = container.querySelector(".task-item .task-hover")!;
      expect([...hover.children].map((e) => e.className)).toEqual(["task-time", "task-delete"]);
      const shown = getComputedStyle(hover);
      expect([shown.position, shown.opacity, shown.pointerEvents]).toEqual([
        "absolute",
        "0",
        "none",
      ]);
      expect(getComputedStyle(hover.querySelector(".task-delete")!).display).not.toBe("none");
      // An archived row's overlay brings its own time over the inline one.
      expect(css).toMatch(
        /\.task-item-archived:hover \.task-name \.task-time \{\s*visibility: hidden;/,
      );
    } finally {
      sheet.remove();
    }
  });

  it("show the lead's unread count on the project's row", () => {
    const props = {
      ...sidebarProps(),
      activeWsId: "w1",
      workspaces: [{ ...lead, messages: [msgOf("a"), msgOf("b")] }, worker],
    };
    const { container } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-group-project")!;
    expect(header.className).not.toContain("active");
    expect(header.querySelector(".unread-badge")!.textContent).toBe("2");
  });

  it("fold from anywhere on the row when the lead is gone", () => {
    const props = { ...sidebarProps(), workspaces: [worker], activeWsId: "w1" };
    const { container } = render(<Sidebar {...props} />);
    fireEvent.click(container.querySelector(".ws-group-project")!);
    expect(props.onToggleGroup).toHaveBeenCalledWith("project:p1", false);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("delete the whole project from the lead's ×, a session on its own", () => {
    const props = sidebarProps();
    const { getAllByTitle, getByTitle } = render(<Sidebar {...props} />);
    fireEvent.click(getByTitle("Delete project"));
    expect(props.onDeleteProject).toHaveBeenCalledWith("p1");
    fireEvent.click(getAllByTitle("Delete")[0]);
    expect(props.onDelete).toHaveBeenCalledWith("w1");
  });
});

describe("messages from the project", () => {
  const msg = (from: Message["from"]): Message => ({
    id: "m",
    kind: "user",
    agentId: null,
    content: "fix it",
    timestamp: NOW,
    status: "done",
    from,
  });

  it("name the lead as the sender and open it on click", () => {
    const onOpen = vi.fn();
    const { getByText, queryByText } = render(
      <MessageItem
        msg={msg({ workspaceId: "lead", name: "lead", role: "lead" })}
        agents={[]}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(queryByText("You")).toBeNull();
    fireEvent.click(getByText("Lead"));
    expect(onOpen).toHaveBeenCalledWith("lead");
  });

  it("name another project's lead by its project", () => {
    const { getByText } = render(
      <MessageItem
        msg={msg({ workspaceId: "ws-x", name: "clangd", role: "peer", projectId: "p2" })}
        agents={[]}
      />,
    );
    expect(getByText("clangd · lead")).toBeTruthy();
  });

  it("name a worker session by its title", () => {
    const { getByText } = render(
      <MessageItem msg={msg({ workspaceId: "w1", name: "modules", role: "worker" })} agents={[]} />,
    );
    expect(getByText("modules").className).toContain("from-author");
  });

  it("name the panel's word about a worker apart from the worker, and open the worker", () => {
    const onOpen = vi.fn();
    const { getByText, container } = render(
      <MessageItem
        msg={msg({ workspaceId: "w1", name: "modules", role: "panel" })}
        agents={[]}
        onOpenWorkspace={onOpen}
      />,
    );
    expect(container.querySelector(".avatar-from")!.textContent).toBe("▣");
    fireEvent.click(getByText("Panel · modules"));
    expect(onOpen).toHaveBeenCalledWith("w1");
  });
});

describe("panel tools in the steps", () => {
  it("read as their own names; other MCP tools keep their server", () => {
    expect(chipLabelFor("mcp__panel__start_session")).toBe("start_session");
    expect(chipLabelFor("mcp__github__get_issue")).toBe("github · get_issue");
    expect(chipLabelFor("Bash")).toBe("Bash");
  });
});

describe("project frames", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("unlink sessions and drop a deleted project, keeping loaded history", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances.at(-1)!;
    const history: Message = {
      id: "m",
      kind: "user",
      agentId: null,
      content: "hi",
      timestamp: NOW,
      status: "done",
    };
    act(() => {
      ws.open();
      ws.receive({
        type: "init",
        workspaces: [lead, worker],
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
        projects: [project],
      });
      ws.receive({ type: "workspace_messages", workspaceId: "w1", messages: [history] });
    });
    expect(result.current.projects).toEqual([project]);

    act(() => {
      ws.receive({ type: "workspace_updated", workspace: { ...worker, projectLink: undefined } });
      ws.receive({ type: "project_deleted", projectId: "p1" });
    });
    const w1 = result.current.workspaces.find((w) => w.id === "w1")!;
    expect(w1.projectLink).toBeUndefined();
    expect(w1.messages).toEqual([history]);
    expect(result.current.projects).toEqual([]);
  });

  it("send project management requests", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances.at(-1)!;
    act(() => ws.open());
    result.current.renameProject("p1", "clice 2");
    result.current.deleteProject("p1");
    expect(ws.frames()).toEqual([
      { type: "rename_project", projectId: "p1", name: "clice 2" },
      { type: "delete_project", projectId: "p1" },
    ]);
  });
});

describe("CreateWorkspaceDialog", () => {
  it("makes a workspace: every folder is a project, so there is no project option", () => {
    const onCreate = vi.fn();
    const { getByPlaceholderText, getByText, queryByRole } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
      />,
    );
    fireEvent.change(getByPlaceholderText("~/workspace/..."), {
      target: { value: "/repo/clice" },
    });
    expect(queryByRole("checkbox")).toBeNull();
    fireEvent.click(getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith("clice", "/repo/clice", "local");
  });

  it("closes on Escape, the path's suggestions first", () => {
    const onClose = vi.fn();
    const { getByPlaceholderText, container } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={onClose}
        onCreate={() => {}}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "/repo/", dirs: ["/repo/clice/", "/repo/other/"] }}
      />,
    );
    fireEvent.change(getByPlaceholderText("~/workspace/..."), { target: { value: "/repo/" } });
    expect(container.querySelector(".dir-suggest")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".dir-suggest")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("archives in the sidebar", () => {
  const archived = (id: string, over: Partial<Workspace> = {}) =>
    ws(id, {
      name: id,
      cwd: "/repo/clice",
      projectLink: { projectId: "p1", role: "worker" },
      archivedAt: NOW - 1000,
      lastMessageAt: NOW - 2000,
      ...over,
    });
  const props = (over: Partial<SidebarProps> = {}): SidebarProps => ({
    workspaces: [lead, worker, archived("old-a"), archived("old-b", { cwd: "/wt/clice-x" })],
    projects: [project],
    activeWsId: "lead",
    connected: true,
    groupOverrides: {},
    seenCounts: {},
    finishedStatus: {},
    searchQuery: "",
    searchHits: null,
    systemStatus: null,
    accounts: [],
    defaultAccount: null,
    now: NOW,
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onToggleGroup: vi.fn(),
    onSearchChange: vi.fn(),
    onJump: vi.fn(),
    onCreate: vi.fn(),
    onCreateIn: vi.fn(),
    onReplayDemo: vi.fn(),
    onDebugSnapshot: vi.fn(),
    onPurgeArchived: vi.fn(),
    onRestoreProject: vi.fn(),
    onSetDefaultAccount: vi.fn(),
    onDeleteProject: vi.fn(),
    ...over,
  });
  const names = (c: HTMLElement) =>
    [...c.querySelectorAll(".task-item .task-name-text")].map((e) => e.textContent);

  it("fold a project's archived sessions under it, and clear only those", () => {
    const p = props();
    const { container, getByTitle } = render(<Sidebar {...p} />);
    expect(names(container)).toEqual(["modules"]);
    expect(container.querySelector(".ws-archived")).toBeNull();
    const toggle = container.querySelector(".ws-archive-toggle")!;
    // Folded, the row is just its name: the count and Clear come with the list.
    expect(toggle.textContent).toBe("▸Archived");
    fireEvent.click(toggle);
    expect(toggle.querySelector(".ws-group-count")!.textContent).toBe("2");
    expect(names(container)).toEqual(["modules", "old-a", "old-b"]);
    // A session in a worktree names its folder.
    expect(
      [...container.querySelectorAll(".task-item-archived .task-meta")].map((e) => e.textContent),
    ).toEqual(["clice-x"]);
    fireEvent.click(getByTitle("Delete the archived sessions of clice"));
    expect(p.onPurgeArchived).toHaveBeenCalledWith("p1");
  });

  it("open the archive that holds the open session", () => {
    const { container } = render(<Sidebar {...props({ activeWsId: "old-a" })} />);
    expect(names(container)).toContain("old-a");
  });

  it("keep archived projects apart, restorable", () => {
    const shelved = { ...project, id: "p2", name: "clice2", root: "/repo/clice2", archivedAt: 1 };
    const lead2 = ws("lead2", {
      name: "clice2 · lead",
      cwd: "/repo/clice2",
      projectLink: { projectId: "p2", role: "lead" },
    });
    const p = props({
      workspaces: [
        lead,
        lead2,
        archived("gone", { projectLink: { projectId: "p2", role: "worker" } }),
      ],
      projects: [project, shelved],
    });
    const { container, getByTitle } = render(<Sidebar {...p} />);
    const labels = () =>
      [...container.querySelectorAll(".ws-group-label")].map((e) => e.textContent);
    expect(labels()).toEqual(["clice", "Archived projects"]);
    fireEvent.click(container.querySelector(".ws-shelf .ws-archived-header")!);
    expect(labels()).toEqual(["clice", "Archived projects", "clice2"]);
    fireEvent.click(getByTitle("Bring clice2 back among the projects"));
    expect(p.onRestoreProject).toHaveBeenCalledWith("p2");
  });

  it("style an archive's row and Restore like the sidebar's own, not bare text and buttons", () => {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.appendChild(sheet);
    try {
      const shelved = { ...project, id: "p2", name: "clice2", root: "/repo/clice2", archivedAt: 1 };
      const lead2 = ws("lead2", {
        cwd: "/repo/clice2",
        projectLink: { projectId: "p2", role: "lead" },
      });
      const { container, getByTitle } = render(
        <Sidebar
          {...props({
            workspaces: [...props().workspaces, lead2],
            projects: [project, shelved],
          })}
        />,
      );
      const toggle = container.querySelector(".ws-archive-toggle")!;
      expect(getComputedStyle(toggle).fontSize).toBe("var(--fs-meta)");
      expect(getComputedStyle(toggle).display).toBe("flex");
      fireEvent.click(container.querySelector(".ws-shelf .ws-archived-header")!);
      const restore = getByTitle("Bring clice2 back among the projects");
      expect(getComputedStyle(restore).borderRadius).toBe("8px");
      // Shown on hover, like the header's other actions.
      expect(getComputedStyle(restore).opacity).toBe("0");
    } finally {
      sheet.remove();
    }
  });

  it("show a project whose lead is archived too", () => {
    const { container } = render(
      <Sidebar
        {...props({ workspaces: [{ ...lead, archivedAt: NOW - 10 }, archived("old-a")] })}
      />,
    );
    expect(container.querySelector(".ws-group-project .ws-group-label")!.textContent).toBe("clice");
  });
});
