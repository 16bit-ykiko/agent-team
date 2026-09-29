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

  it("show the lead tag and no quick-create on the project header", () => {
    const { container } = render(<Sidebar {...sidebarProps()} />);
    expect(container.querySelector(".ws-group-project .ws-group-label")!.textContent).toBe("clice");
    expect(container.querySelector(".ws-group-add")).toBeNull();
    const names = [...container.querySelectorAll(".task-name-text")].map((e) => e.textContent);
    expect(names).toEqual(["lead", "modules"]);
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
    result.current.createProject("clice", "/repo/clice", "claude-opus-5-5");
    result.current.renameProject("p1", "clice 2");
    result.current.deleteProject("p1");
    expect(ws.frames()).toEqual([
      { type: "create_project", name: "clice", path: "/repo/clice", model: "claude-opus-5-5" },
      { type: "rename_project", projectId: "p1", name: "clice 2" },
      { type: "delete_project", projectId: "p1" },
    ]);
  });
});

describe("CreateWorkspaceDialog as a project", () => {
  it("creates a project instead of a workspace when ticked", () => {
    const onCreate = vi.fn();
    const onCreateProject = vi.fn();
    const { getByPlaceholderText, getByRole, getByText } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={() => {}}
        onCreate={onCreate}
        onCreateProject={onCreateProject}
        models={[
          { id: "claude-opus-5-5[1m]", label: "Opus 5.5 1M", backend: "claude" },
          { id: "claude-fable-5-1", label: "Fable 5.1", backend: "claude" },
          { id: "gpt-5", label: "GPT-5", backend: "codex" },
        ]}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
      />,
    );
    fireEvent.change(getByPlaceholderText("~/workspace/..."), {
      target: { value: "/repo/clice" },
    });
    fireEvent.click(getByRole("checkbox"));
    expect(getByText("New Project")).toBeTruthy();
    const select = getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "claude-opus-5-5[1m]",
      "claude-fable-5-1",
    ]);
    fireEvent.change(select, { target: { value: "claude-fable-5-1" } });
    fireEvent.click(getByText("Create"));
    expect(onCreateProject).toHaveBeenCalledWith("clice", "/repo/clice", "claude-fable-5-1");
    expect(onCreate).not.toHaveBeenCalled();
  });
});
