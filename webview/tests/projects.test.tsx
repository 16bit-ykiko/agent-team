import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, renderHook, act } from "@testing-library/react";
import { groupWorkspaces } from "../src/sidebar/groups";
import { Sidebar, type SidebarProps } from "../src/sidebar/Sidebar";
import { MessageItem, chipLabelFor } from "../src/chat/messages";
import { CreateWorkspaceDialog } from "../src/workspace/dialogs";
import { useServer, type Message, type Project, type Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

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
    expect(header.querySelector(".ws-group-count")!.textContent).toBe("1");
    fireEvent.click(header);
    expect(props.onSelect).toHaveBeenCalledWith("lead");
    expect(props.onToggleGroup).not.toHaveBeenCalled();
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
});
