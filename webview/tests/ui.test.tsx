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

describe("BannerItem folding", () => {
  const long =
    "Wake up in 25m (01:23 AM) — codex migration run takes tens of minutes\n\n> Check on the background codex migration run: tail the log, check the report, and git log for new commits.";

  it("folds wake-up, schedule and skill prompts to their first line until opened", () => {
    const { container, getByText } = render(
      <BannerItem ev={ev("notice", { level: "schedule", content: long })} />,
    );
    expect(container.querySelector(".banner-label")!.textContent).toBe("Scheduled");
    expect(container.querySelector(".banner-first-line")!.textContent).toBe(
      "Wake up in 25m (01:23 AM) — codex migration run takes tens of minutes",
    );
    expect(container.textContent).not.toContain("tail the log");
    fireEvent.click(getByText("more"));
    expect(container.textContent).toContain("tail the log");
    expect(container.querySelector("blockquote")).not.toBeNull();
    fireEvent.click(getByText("less"));
    expect(container.textContent).not.toContain("tail the log");
  });

  it("labels a skill expansion and leaves short banners unfolded", () => {
    const { container } = render(
      <BannerItem
        ev={ev("notice", { level: "skill", content: "Base directory for this skill: /x\n# Docs" })}
      />,
    );
    expect(container.querySelector(".banner-label")!.textContent).toBe("Skill");
    expect(container.querySelector(".banner-toggle")).not.toBeNull();
    const { container: short } = render(
      <BannerItem ev={ev("notice", { level: "wakeup", content: "Scheduled wake-up fired." })} />,
    );
    expect(short.querySelector(".banner-toggle")).toBeNull();
    expect(short.textContent).toContain("Scheduled wake-up fired.");
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
    git: null,
    pr: null,
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
    onDebugSnapshot: vi.fn(),
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

describe("StepGroup timeline", () => {
  it("renders a subagent card between the tool calls that surround it", () => {
    const events = [
      ev("tool_use", { toolName: "Read", content: "**Read** `a`" }),
      ev("tool_use", { toolName: "Read", content: "**Read** `b`" }),
      ev("subagent_start", {
        subagent: { taskId: "t", description: "review", agentType: "shell", status: "running" },
      }),
      ev("tool_use", { toolName: "Bash", content: "**Bash** ls" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);
    const kids = [...container.children].map((el) => el.className.split(" ")[0]);
    expect(kids).toEqual(["step-group", "subagent-item", "step-group"]);
    const summaries = [...container.querySelectorAll(".step-summary")].map((e) => e.textContent);
    expect(summaries).toEqual(["2 tool calls", "1 tool call"]);
    expect(container.querySelector(".subagent-label")!.textContent).toBe("shell");
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
          git: null,
          pr: null,
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
      onDebugSnapshot: vi.fn(),
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

describe("message status row and timestamps", () => {
  const base: Message = {
    id: "m",
    kind: "agent",
    agentId: "a1",
    content: "done",
    timestamp: Date.UTC(2026, 0, 1, 10, 30),
    status: "done",
    events: [],
  };

  it("shows effort and context occupancy under the header, colored by pressure", () => {
    const { container, rerender } = render(
      <MessageItem
        msg={{ ...base, effort: "high", context: { tokens: 84000, window: 200000 } }}
        agents={[agent]}
      />,
    );
    const row = container.querySelector(".message-status")!;
    expect(row.textContent).toContain("effort high");
    expect(row.textContent).toContain("ctx 84k / 200k · 42%");
    expect(row.querySelector(".ctx-chip")!.className).not.toContain("ctx-warn");
    rerender(
      <MessageItem
        msg={{ ...base, context: { tokens: 185000, window: 200000 } }}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".ctx-chip")!.className).toContain("ctx-high");
    expect(container.querySelector(".message-status")!.textContent).not.toContain("effort");
  });

  it("marks turns that ran in fast mode", () => {
    const { container } = render(<MessageItem msg={{ ...base, fast: true }} agents={[agent]} />);
    const chip = container.querySelector(".fast-chip")!;
    expect(chip.textContent).toContain("fast");
    expect(container.querySelector(".message-status")!.textContent).not.toContain("effort");
  });

  it("renders nothing for messages without effort or context, and never for user messages", () => {
    const { container, rerender } = render(<MessageItem msg={base} agents={[agent]} />);
    expect(container.querySelector(".message-status")).toBeNull();
    rerender(
      <MessageItem
        msg={{ ...base, kind: "user", agentId: null, effort: "high" }}
        agents={[agent]}
      />,
    );
    expect(container.querySelector(".message-status")).toBeNull();
  });

  it("keeps a timestamp on compact continuation messages", () => {
    const { container } = render(<MessageItem msg={base} agents={[agent]} compact />);
    expect(container.querySelector(".message-header")).toBeNull();
    expect(container.querySelector(".compact-header .message-time")!.textContent).toMatch(/\d/);
  });
});

describe("scheduled wake-ups", () => {
  it("gives ScheduleWakeup calls a schedule chip with a readable summary", () => {
    const { container } = render(
      <EventItem
        ev={ev("tool_use", {
          toolName: "ScheduleWakeup",
          content: "**ScheduleWakeup** in 8m — watching CI\n\n> check CI",
        })}
      />,
    );
    const chip = container.querySelector(".event-chip")!;
    expect(chip.className).toContain("chip-schedule");
    expect(chip.textContent).toBe("⏰ Wake-up");
    expect(container.querySelector(".event-content")!.textContent).toContain("check CI");
  });

  it("renders the fired wake-up as its own banner", () => {
    const { container } = render(
      <BannerItem ev={ev("notice", { level: "wakeup", content: "Scheduled wake-up: check CI" })} />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-wakeup");
    expect(el.querySelector(".banner-label")!.textContent).toBe("Woke up");
    expect(el.textContent).toContain("check CI");
  });
});

describe("scheduled banner", () => {
  it("renders the schedule with its label and the planned prompt", () => {
    const { container } = render(
      <BannerItem
        ev={ev("notice", {
          level: "schedule",
          content: "Wake up in 8m (02:10) — watching CI\n\n> check CI",
        })}
      />,
    );
    const el = container.querySelector(".banner")!;
    expect(el.className).toContain("banner-schedule");
    expect(el.querySelector(".banner-label")!.textContent).toBe("Scheduled");
    expect(el.textContent).toContain("Wake up in 8m");
    // The planned prompt is behind the fold.
    expect(el.querySelector("blockquote")).toBeNull();
    fireEvent.click(el.querySelector(".banner-toggle")!);
    expect(el.querySelector("blockquote")!.textContent).toContain("check CI");
  });
});

describe("GitBar", () => {
  it("shows branch with dirty/ahead/behind badges and a PR card with state and checks", async () => {
    const { GitBar } = await import("../src/GitBar");
    const { container } = render(
      <GitBar
        git={{ branch: "feat/x", dirty: 3, ahead: 1, behind: 0 }}
        pr={{
          number: 243,
          url: "https://x/pull/243",
          title: "Fix it",
          state: "open",
          draft: false,
          checks: "pending",
        }}
      />,
    );
    expect(container.querySelector(".ws-branch-name")!.textContent).toBe("feat/x");
    expect([...container.querySelectorAll(".git-badge")].map((b) => b.textContent)).toEqual([
      "●3",
      "↑1",
    ]);
    const pr = container.querySelector(".pr-card")!;
    expect(pr.className).toContain("pr-open");
    expect(pr.textContent).toContain("#243");
    expect(pr.textContent).toContain("Fix it");
    expect(pr.querySelector(".pr-state")!.textContent).toBe("open");
    expect(pr.querySelector(".pr-checks")!.className).toContain("pr-checks-pending");
  });

  it("renders merged/draft states and nothing when there is no git info", async () => {
    const { GitBar } = await import("../src/GitBar");
    const { container, rerender } = render(
      <GitBar
        git={{ branch: "b", dirty: 0, ahead: 0, behind: 0 }}
        pr={{ number: 1, url: "u", title: "", state: "merged", draft: true, checks: null }}
      />,
    );
    expect(container.querySelector(".pr-state")!.textContent).toBe("merged");
    expect(container.querySelector(".git-badge")).toBeNull();
    rerender(<GitBar git={null} pr={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("summary pages and lazy details", () => {
  it("renders a summarised thinking event as a placeholder that requests details", () => {
    const onLoad = vi.fn();
    const { container, getByText } = render(
      <EventItem
        ev={ev("thinking", { content: "", contentLength: 4200 })}
        onLoadDetails={onLoad}
      />,
    );
    expect(container.querySelector(".event-placeholder")!.textContent).toContain("4.2k chars");
    fireEvent.click(getByText(/tap to load/));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("shows the result size from the summary and loads on toggle", () => {
    const onLoad = vi.fn();
    const { getByText, container } = render(
      <EventItem
        ev={ev("tool_use", { toolName: "Read", content: "**Read** `a`", resultLength: 12000 })}
        onLoadDetails={onLoad}
      />,
    );
    fireEvent.click(getByText(/^Result · 12k chars/));
    expect(onLoad).toHaveBeenCalledTimes(1);
    // Nothing to show yet; no empty result box.
    expect(container.querySelector(".event-result")).toBeNull();
  });

  it("requests details when a step group of a summarised message is opened", () => {
    const onLoadDetails = vi.fn();
    const msg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "",
      timestamp: 0,
      status: "done",
      detail: "summary",
      events: [ev("thinking", { content: "", contentLength: 10 })],
    };
    const { container } = render(
      <MessageItem msg={msg} agents={[agent]} onLoadDetails={onLoadDetails} />,
    );
    fireEvent.click(container.querySelector(".step-header")!);
    expect(onLoadDetails).toHaveBeenCalledWith("m1");
  });

  it("does not request details once the message is full", () => {
    const onLoadDetails = vi.fn();
    const msg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "",
      timestamp: 0,
      status: "done",
      events: [ev("thinking", { content: "body" })],
    };
    const { container } = render(
      <MessageItem msg={msg} agents={[agent]} onLoadDetails={onLoadDetails} />,
    );
    fireEvent.click(container.querySelector(".step-header")!);
    expect(onLoadDetails).not.toHaveBeenCalled();
    expect(container.querySelector(".event-content")!.textContent).toContain("body");
  });
});

describe("HistoryHint", () => {
  it("walks through loading, older-available, and start-of-conversation", async () => {
    const { HistoryHint } = await import("../src/HistoryHint");
    const { container, rerender } = render(
      <HistoryHint hasMore={false} loading={false} loaded={false} count={0} />,
    );
    expect(container.textContent).toContain("Loading conversation");
    rerender(<HistoryHint hasMore loading loaded count={5} />);
    expect(container.textContent).toContain("Loading older messages");
    expect(container.querySelector(".spinner")).toBeTruthy();
    rerender(<HistoryHint hasMore loading={false} loaded count={5} />);
    expect(container.textContent).toContain("Scroll up");
    rerender(<HistoryHint hasMore={false} loading={false} loaded count={5} />);
    expect(container.textContent).toContain("Beginning of conversation");
    rerender(<HistoryHint hasMore={false} loading={false} loaded count={0} />);
    expect(container.innerHTML).toBe("");
  });
});
