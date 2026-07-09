import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SubAgentItem, StepGroup, MessageItem } from "../src/App";
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
    expect(item.closest(".message-events")).toBeNull();
    expect(container.querySelector(".message-events")).toBeTruthy();
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
