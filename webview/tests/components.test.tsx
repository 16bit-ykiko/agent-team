import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { SubAgentItem, StepGroup, MessageItem, CreateWorkspaceDialog } from "../src/App";
import { HostInfo } from "../src/useServer";
import { StreamEvent, Message, AgentInfo } from "../src/useServer";

const sa = (over: Partial<NonNullable<StreamEvent["subagent"]>> = {}): StreamEvent =>
  ({
    kind: "subagent_start",
    content: "",
    subagent: { taskId: "task-1", description: "explore the repo", agentType: "Explore", ...over },
  }) as StreamEvent;

describe("SubAgentItem", () => {
  it("shows a cancel button while running and reports the taskId", () => {
    const onCancel = vi.fn();
    const { container, getByTitle } = render(
      <SubAgentItem ev={sa({ status: "running" })} onCancel={onCancel} />,
    );

    fireEvent.click(getByTitle("Cancel this subagent"));
    expect(onCancel).toHaveBeenCalledWith("task-1");
    // Clicking cancel must not toggle the details open.
    expect(container.querySelector(".subagent-details")).toBeNull();
  });

  it("hides the cancel button once the subagent is done", () => {
    const { container } = render(
      <SubAgentItem ev={sa({ status: "completed" })} onCancel={() => {}} />,
    );
    expect(container.querySelector(".btn-cancel-subagent")).toBeNull();
    expect(container.querySelector(".subagent-item")!.className).toContain("subagent-completed");
  });

  it("renders a stopped subagent with its own status style", () => {
    const { container } = render(<SubAgentItem ev={sa({ status: "stopped" })} />);
    expect(container.querySelector(".subagent-item")!.className).toContain("subagent-stopped");
  });

  it("renders nested subagents as nested SubAgentItems with merged lifecycle", () => {
    const nestedEvents: StreamEvent[] = [
      { kind: "tool_use", content: "Read /a", toolUseId: "t1" } as StreamEvent,
      {
        kind: "subagent_start",
        content: "",
        subagent: { taskId: "nested-1", description: "inner search", agentType: "Explore" },
      } as StreamEvent,
      {
        kind: "subagent_done",
        content: "",
        subagent: { taskId: "nested-1", description: "", status: "completed" },
      } as StreamEvent,
    ];
    const { container, getByText } = render(
      <SubAgentItem ev={sa({ status: "running", events: nestedEvents })} />,
    );
    fireEvent.click(container.querySelector(".subagent-header")!);

    const items = container.querySelectorAll(".subagent-item");
    expect(items).toHaveLength(2); // parent + one nested (start/done folded)
    expect(items[1].className).toContain("subagent-completed");
    expect(getByText("inner search")).toBeTruthy();
    // The nested lifecycle events must not leak into the regular event list.
    expect(container.querySelectorAll(".event-subagent_start")).toHaveLength(0);
  });
});

describe("StepGroup", () => {
  it("renders subagents as sibling blocks, not inside the step box", () => {
    const events: StreamEvent[] = [
      { kind: "tool_use", content: "Bash ls", toolUseId: "t1" } as StreamEvent,
      sa({ status: "running" }),
    ];
    const { container } = render(<StepGroup group={{ step: 0, events }} />);

    const item = container.querySelector(".subagent-item")!;
    expect(item).toBeTruthy();
    expect(item.closest(".step-group")).toBeNull();
    expect(container.querySelector(".step-group")).toBeTruthy();
  });

  it("omits the step box entirely when a segment only contains a subagent", () => {
    const { container } = render(<StepGroup group={{ step: 0, events: [sa()] }} />);
    expect(container.querySelector(".step-group")).toBeNull();
    expect(container.querySelector(".subagent-item")).toBeTruthy();
  });
});

describe("MessageItem", () => {
  const agents: AgentInfo[] = [
    {
      id: "a1",
      name: "Alice",
      model: "claude-fable-5",
      avatar: "🤖",
      color: "#888",
      isDefault: true,
    },
  ];
  const msg = (over: Partial<Message>): Message => ({
    id: "m1",
    kind: "agent",
    agentId: "a1",
    content: "",
    timestamp: 0,
    status: "done",
    ...over,
  });

  it("renders subagents outside the collapsed events box", () => {
    const events: StreamEvent[] = [
      { kind: "thinking", content: "hmm" } as StreamEvent,
      sa({ status: "completed" }),
    ];
    const { container } = render(<MessageItem msg={msg({ events })} agents={agents} />);

    const item = container.querySelector(".subagent-item")!;
    expect(item).toBeTruthy();
    expect(item.closest(".step-group")).toBeNull();
    expect(container.querySelector(".step-group")).toBeTruthy();
  });

  it("interleaves text segments and event groups by contentOffset", () => {
    const part1 = "Let me read the file first.";
    const part2 = "Done — the bug is in the parser.";
    const events: StreamEvent[] = [
      {
        kind: "tool_use",
        content: "Read /a",
        toolUseId: "t1",
        contentOffset: part1.length,
      } as StreamEvent,
      { ...sa({ status: "completed" }), contentOffset: part1.length },
    ];
    const { container, getByText } = render(
      <MessageItem msg={msg({ content: part1 + part2, events })} agents={agents} />,
    );

    // Both text segments render, split around the event group.
    expect(getByText(part1)).toBeTruthy();
    expect(getByText(part2)).toBeTruthy();
    // The subagent renders as a standalone block outside the step box.
    const item = container.querySelector(".subagent-item")!;
    expect(item).toBeTruthy();
    expect(item.closest(".step-group")).toBeNull();
    expect(container.querySelector(".step-group")).toBeTruthy();
  });

  it("wires cancel through to the owning agent", () => {
    const onCancelSubagent = vi.fn();
    const events: StreamEvent[] = [sa({ status: "running" })];
    const { getByTitle } = render(
      <MessageItem
        msg={msg({ events, status: "streaming" })}
        agents={agents}
        onCancelSubagent={onCancelSubagent}
      />,
    );
    fireEvent.click(getByTitle("Cancel this subagent"));
    expect(onCancelSubagent).toHaveBeenCalledWith("a1", "task-1");
  });
});

describe("CreateWorkspaceDialog", () => {
  const hosts: HostInfo[] = [{ id: "local", label: "Local", type: "local", connected: true }];

  function setup(dirSuggestions = { prefix: "", dirs: [] as string[] }) {
    const onCreate = vi.fn();
    const onListDirs = vi.fn();
    const utils = render(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={dirSuggestions}
      />,
    );
    const pathInput = utils.getByPlaceholderText("~/workspace/...") as HTMLInputElement;
    return { ...utils, onCreate, onListDirs, pathInput };
  }

  it("requests directory completion while typing (debounced)", () => {
    vi.useFakeTimers();
    try {
      const { onListDirs, pathInput } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/y" } });
      fireEvent.change(pathInput, { target: { value: "/home/yk" } });
      expect(onListDirs).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      // Only the final value survives the debounce.
      expect(onListDirs).toHaveBeenCalledTimes(1);
      expect(onListDirs).toHaveBeenCalledWith("/home/yk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows suggestions matching the current input and completes on click", () => {
    const { pathInput, getByText, rerender, onCreate, onListDirs } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/yk" } });
    rerender(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={{ prefix: "/home/yk", dirs: ["/home/ykiko/"] }}
      />,
    );
    fireEvent.mouseDown(getByText("/home/ykiko/"));
    expect(pathInput.value).toBe("/home/ykiko/");
  });

  it("ignores stale suggestions for older input", () => {
    const { pathInput, container, onCreate, onListDirs, rerender } = setup();
    fireEvent.change(pathInput, { target: { value: "/tmp/x" } });
    rerender(
      <CreateWorkspaceDialog
        hosts={hosts}
        onClose={() => {}}
        onCreate={onCreate}
        onListDirs={onListDirs}
        dirSuggestions={{ prefix: "/home/yk", dirs: ["/home/ykiko/"] }}
      />,
    );
    expect(container.querySelector(".dir-suggest")).toBeNull();
  });

  it("submits name + path, defaulting the name to the folder basename", () => {
    const { pathInput, onCreate, getByText } = setup();
    fireEvent.change(pathInput, { target: { value: "/home/ykiko/clice" } });
    fireEvent.click(getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith("clice", "/home/ykiko/clice", "local");
  });

  it("closes the suggestion list when the path input loses focus (mobile has no Esc)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, container, onCreate, onListDirs, rerender } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/yk" } });
      rerender(
        <CreateWorkspaceDialog
          hosts={hosts}
          onClose={() => {}}
          onCreate={onCreate}
          onListDirs={onListDirs}
          dirSuggestions={{ prefix: "/home/yk", dirs: ["/home/ykiko/"] }}
        />,
      );
      expect(container.querySelector(".dir-suggest")).not.toBeNull();

      fireEvent.blur(pathInput);
      act(() => vi.advanceTimersByTime(200));
      expect(container.querySelector(".dir-suggest")).toBeNull();

      // Refocusing brings it back before the user types anything.
      fireEvent.focus(pathInput);
      expect(container.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the list open across a quick blur/focus (tapping a suggestion)", () => {
    vi.useFakeTimers();
    try {
      const { pathInput, container, onCreate, onListDirs, rerender } = setup();
      fireEvent.change(pathInput, { target: { value: "/home/yk" } });
      rerender(
        <CreateWorkspaceDialog
          hosts={hosts}
          onClose={() => {}}
          onCreate={onCreate}
          onListDirs={onListDirs}
          dirSuggestions={{ prefix: "/home/yk", dirs: ["/home/ykiko/"] }}
        />,
      );
      fireEvent.blur(pathInput);
      fireEvent.focus(pathInput); // cancels the pending close
      act(() => vi.advanceTimersByTime(300));
      expect(container.querySelector(".dir-suggest")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MessageItem queued state", () => {
  const agents: AgentInfo[] = [
    { id: "a1", name: "Alice", model: "m", avatar: "A", color: "#888", isDefault: true },
  ];
  const queuedMsg: Message = {
    id: "mq",
    kind: "user",
    agentId: null,
    content: "do this next",
    timestamp: 0,
    status: "queued",
    queuedFor: "a1",
  };

  it("renders a queued badge, dims the message, and cancels via the badge", () => {
    const onCancelQueued = vi.fn();
    const { container, getByTitle, getByText } = render(
      <MessageItem msg={queuedMsg} agents={agents} onCancelQueued={onCancelQueued} />,
    );
    expect(getByText("queued")).toBeTruthy();
    expect(container.querySelector(".message")!.className).toContain("message-queued");
    fireEvent.click(getByTitle("Remove from queue"));
    expect(onCancelQueued).toHaveBeenCalledWith("mq");
  });

  it("renders normally once the message leaves the queue", () => {
    const { container } = render(
      <MessageItem msg={{ ...queuedMsg, status: "done", queuedFor: undefined }} agents={agents} />,
    );
    expect(container.querySelector(".queued-badge")).toBeNull();
    expect(container.querySelector(".message")!.className).not.toContain("message-queued");
  });
});

describe("MessageItem events without contentOffset", () => {
  it("renders them after the text instead of dropping them", () => {
    const agents: AgentInfo[] = [
      { id: "a1", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true },
    ];
    const events: StreamEvent[] = [
      { kind: "tool_use", content: "**Read** `a`", contentOffset: 0 } as StreamEvent,
      { kind: "notice", level: "warning", content: "late banner" } as StreamEvent,
      { kind: "error", content: "boom" } as StreamEvent,
    ];
    const msg: Message = {
      id: "m",
      kind: "agent",
      agentId: "a1",
      content: "Some text.",
      timestamp: 0,
      status: "done",
      events,
    };
    const { container } = render(<MessageItem msg={msg} agents={agents} />);
    expect(container.querySelector(".banner")!.textContent).toContain("late banner");
    const stepGroups = container.querySelectorAll(".step-group");
    expect(stepGroups).toHaveLength(2);
    // The text sits between the leading tool call and the trailing events.
    const body = container.querySelector(".message-content")!;
    const order = [...body.querySelectorAll(".step-group, p, .banner")]
      .filter((el) => el.tagName !== "P" || !el.closest(".banner"))
      .map((el) =>
        el.className.includes("banner") ? "banner" : el.tagName === "P" ? "text" : "step",
      );
    // Trailing events keep their own order: the banner came before the error.
    expect(order).toEqual(["step", "text", "banner", "step"]);
  });
});

describe("MessageItem subagent lifecycle placement", () => {
  it("keeps progress/done events with their start even without an offset", () => {
    const agents: AgentInfo[] = [
      { id: "a1", name: "A", model: "m", avatar: "x", color: "#fff", isDefault: true },
    ];
    const events: StreamEvent[] = [
      {
        kind: "subagent_start",
        content: "",
        contentOffset: 0,
        subagent: { taskId: "t", description: "search", agentType: "Explore", status: "running" },
      } as StreamEvent,
      {
        kind: "subagent_done",
        content: "",
        subagent: { taskId: "t", description: "", status: "completed" },
      } as StreamEvent,
    ];
    const msg: Message = {
      id: "m",
      kind: "agent",
      agentId: "a1",
      content: "Delegating.",
      timestamp: 0,
      status: "done",
      events,
    };
    const { container } = render(<MessageItem msg={msg} agents={agents} />);
    const items = container.querySelectorAll(".subagent-item");
    expect(items).toHaveLength(1);
    expect(items[0].className).toContain("subagent-completed");
    expect(items[0].querySelector(".subagent-label")!.textContent).toBe("Explore");
  });
});
