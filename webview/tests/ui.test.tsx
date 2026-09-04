import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EventItem, BannerItem, StepGroup, MessageItem } from "../src/messages";
import { Sidebar, SidebarProps } from "../src/Sidebar";
import { ConfirmDialog } from "../src/dialogs";
import { StreamEvent, Message, AgentInfo, Workspace } from "../src/useServer";

const ev = (kind: string, over: Partial<StreamEvent> = {}): StreamEvent =>
  ({ kind, content: "", ...over }) as StreamEvent;

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-fable-5-1",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

describe("EventItem", () => {
  it("renders a tool chip with a one-line summary for single-line tools", () => {
    const { container, queryByText } = render(
      <EventItem ev={ev("tool_use", { toolName: "Read", content: "**Read** `src/a.ts`" })} />,
    );
    expect(container.querySelector(".event-chip")!.textContent).toBe("Read");
    expect(container.querySelector(".event-summary")!.textContent).toBe("src/a.ts");
    // Nothing else to show: the body is the summary.
    expect(container.querySelector(".event-content")).toBeNull();
    expect(queryByText("Details")).toBeNull();
  });

  it("shows the body of multi-line tool calls (commands, diffs) by default", () => {
    const { container } = render(
      <EventItem ev={ev("tool_use", { content: "**Bash**\n```bash\nnpm test\n```" })} />,
    );
    expect(container.querySelector(".event-chip")!.textContent).toBe("Bash");
    expect(container.querySelector(".event-content")!.textContent).toContain("npm test");
  });

  it("toggles the paired tool result", () => {
    const { container, getByText } = render(
      <EventItem
        ev={ev("tool_use", { content: "**Read** `a`", toolUseId: "t1", toolResult: "file body" })}
      />,
    );
    expect(container.querySelector(".event-result")).toBeNull();
    fireEvent.click(getByText(/^Result/));
    expect(container.querySelector(".event-result")!.textContent).toContain("file body");
  });

  it("labels thinking with its own chip", () => {
    const { container } = render(<EventItem ev={ev("thinking", { content: "hmm" })} />);
    expect(container.querySelector(".chip-thinking")!.textContent).toBe("Thinking");
  });
});

describe("BannerItem", () => {
  it("renders notices with their level and markdown content", () => {
    const { container } = render(
      <BannerItem ev={ev("notice", { level: "warning", content: "**Plan**\n- [ ] step" })} />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-warning");
    expect(el.querySelector("strong")!.textContent).toBe("Plan");
  });

  it("renders retries and compaction with kind-specific styling", () => {
    const { container } = render(
      <>
        <BannerItem ev={ev("retry", { content: "API retry 2/10" })} />
        <BannerItem ev={ev("compact", { content: "compacted" })} />
      </>,
    );
    const banners = container.querySelectorAll(".banner");
    expect(banners[0].className).toContain("banner-retry");
    expect(banners[1].className).toContain("banner-compact");
  });
});

describe("StepGroup", () => {
  it("shows tool chips in the collapsed header and banners as siblings", () => {
    const events = [
      ev("tool_use", { content: "**Read** `a`" }),
      ev("tool_use", { content: "**Grep** `foo`" }),
      ev("tool_use", { content: "**Read** `b`" }),
      ev("notice", { level: "notice", content: "note" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    const chips = [...container.querySelectorAll(".step-tools .event-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["Read", "Grep"]);
    expect(container.querySelector(".step-summary")!.textContent).toBe("3 tool calls");
    const banner = container.querySelector(".banner")!;
    expect(banner.closest(".step-group")).toBeNull();
    fireEvent.click(container.querySelector(".step-header")!);
    expect(container.querySelectorAll(".events-list .event")).toHaveLength(3);
    expect(container.querySelector(".step-tools")).toBeNull();
  });
});

describe("MessageItem activity", () => {
  const msg = (over: Partial<Message> = {}): Message => ({
    id: "m1",
    kind: "agent",
    agentId: "a1",
    content: "",
    timestamp: 0,
    status: "streaming",
    events: [],
    ...over,
  });

  it("shows the agent's activity instead of the generic working indicator", () => {
    const { container } = render(
      <MessageItem
        msg={msg()}
        agents={[{ ...agent, busy: true, activity: "compacting context" }]}
      />,
    );
    expect(container.querySelector(".working-indicator")!.textContent).toBe("compacting context");
    expect(container.querySelector(".activity-label")!.textContent).toBe("compacting context");
  });

  it("falls back to Working... and hides the label once the message is done", () => {
    const { container, rerender } = render(<MessageItem msg={msg()} agents={[agent]} />);
    expect(container.querySelector(".working-indicator")!.textContent).toBe("Working...");
    rerender(
      <MessageItem
        msg={msg({ status: "done", content: "hi" })}
        agents={[{ ...agent, activity: "stale" }]}
      />,
    );
    expect(container.querySelector(".activity-label")).toBeNull();
    expect(container.querySelector(".working-indicator")).toBeNull();
  });
});

describe("Sidebar archived section", () => {
  const NOW = 1_800_000_000_000;
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id,
    project: "proj",
    hostId: "local",
    cwd: "/repo",
    gitBranch: null,
    prUrl: null,
    prTitle: null,
    agents: [],
    messages: [],
    createdAt: NOW - 1000,
    lastMessageAt: NOW - 1000,
    ...over,
  });
  const base = (over: Partial<SidebarProps> = {}): SidebarProps => ({
    workspaces: [
      ws("live"),
      ws("dusty", { archivedAt: NOW - 86_400_000, lastMessageAt: NOW - 20 * 86_400_000 }),
    ],
    activeWsId: "live",
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
    onPurgeArchived: vi.fn(),
    onSetDefaultAccount: vi.fn(),
    ...over,
  });

  it("folds archived workspaces into a collapsed section with a count", () => {
    const props = base();
    const { container, getByTitle } = render(<Sidebar {...props} />);
    const header = container.querySelector(".ws-archived-header")!;
    expect(header.querySelector(".ws-group-count")!.textContent).toBe("1");
    expect(container.querySelector(".task-item-archived")).toBeNull();
    // The live group does not list the archived one.
    expect(
      [...container.querySelectorAll(".ws-group-items .task-name-text")].map((e) => e.textContent),
    ).toEqual(["live"]);

    fireEvent.click(header);
    const item = container.querySelector(".task-item-archived")!;
    expect(item.textContent).toContain("dusty");
    expect(item.textContent).toContain("20d ago");
    fireEvent.click(item);
    expect(props.onSelect).toHaveBeenCalledWith("dusty");

    fireEvent.click(getByTitle("Delete all archived workspaces"));
    expect(props.onPurgeArchived).toHaveBeenCalled();
    // Clicking Clear must not toggle the section.
    expect(container.querySelector(".task-item-archived")).toBeTruthy();
  });

  it("keeps the section open while an archived workspace is active", () => {
    const { container } = render(<Sidebar {...base({ activeWsId: "dusty" })} />);
    expect(container.querySelector(".task-item-archived.active")).toBeTruthy();
  });

  it("omits the section when nothing is archived", () => {
    const { container } = render(<Sidebar {...base({ workspaces: [ws("live")] })} />);
    expect(container.querySelector(".ws-archived")).toBeNull();
  });

  it("shows agent activity next to busy agents", () => {
    const busy = ws("live", {
      agents: [{ ...agent, busy: true, activity: "Bash · 12s" }],
    });
    const { container } = render(<Sidebar {...base({ workspaces: [busy] })} />);
    expect(container.querySelector(".task-active-agent")!.textContent).toBe("Alice · Bash · 12s");
  });
});

describe("ConfirmDialog", () => {
  it("confirms then closes, and cancels without confirming", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(
      <ConfirmDialog
        title="T"
        body="B"
        confirmLabel="Do it"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("Do it"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("Cancel"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ConfirmDialog title="T" body="B" onConfirm={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("StepGroup summary", () => {
  it("counts only what is inside the box, naming errors", () => {
    const events = [
      ev("error", { content: "boom" }),
      ev("notice", { level: "notice", content: "banner outside" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    expect(container.querySelector(".step-summary")!.textContent).toBe("1 error");
    const { container: c2 } = render(
      <StepGroup group={{ step: 0, events: [ev("tool_result", { content: "x" })] }} />,
    );
    expect(c2.querySelector(".step-summary")!.textContent).toBe("1 event");
  });
});

describe("Sidebar group quick-create", () => {
  it("offers a + on each folder group that creates in that folder without toggling it", () => {
    const NOW = 1_800_000_000_000;
    const props: SidebarProps = {
      workspaces: [
        {
          id: "w",
          name: "w",
          project: "repo",
          hostId: "local",
          cwd: "/home/me/repo",
          gitBranch: null,
          prUrl: null,
          prTitle: null,
          agents: [],
          messages: [],
          createdAt: NOW - 1000,
          lastMessageAt: NOW - 1000,
        },
      ],
      activeWsId: "w",
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
      onPurgeArchived: vi.fn(),
      onSetDefaultAccount: vi.fn(),
    };
    const { getByTitle } = render(<Sidebar {...props} />);
    fireEvent.click(getByTitle("New workspace in /home/me/repo"));
    expect(props.onCreateIn).toHaveBeenCalledWith("/home/me/repo");
    expect(props.onToggleGroup).not.toHaveBeenCalled();
  });
});

describe("CreateWorkspaceDialog initial path", () => {
  it("pre-fills the path and derives the default name from it", async () => {
    const { CreateWorkspaceDialog } = await import("../src/dialogs");
    const onCreate = vi.fn();
    const { getByPlaceholderText, getByDisplayValue, getByText } = render(
      <CreateWorkspaceDialog
        hosts={[]}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={() => {}}
        dirSuggestions={{ prefix: "", dirs: [] }}
        initialPath="/home/me/repo"
      />,
    );
    expect(getByDisplayValue("/home/me/repo")).toBeTruthy();
    expect(getByPlaceholderText("repo")).toBeTruthy();
    fireEvent.click(getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith("repo", "/home/me/repo", "local");
  });
});
