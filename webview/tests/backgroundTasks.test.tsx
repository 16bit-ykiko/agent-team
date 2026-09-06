import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BackgroundTasksBar, elapsedLabel, taskTypeLabel } from "../src/BackgroundTasks";
import type { AgentInfo } from "../src/useServer";

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a1",
  name: "Alice",
  model: "claude-fable-5-1",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
  ...over,
});

describe("BackgroundTasksBar", () => {
  it("renders nothing when no agent has background work", () => {
    const { container } = render(<BackgroundTasksBar agents={[agent()]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists every live task with its agent, kind and elapsed time", () => {
    const since = Date.now() - 3 * 60_000;
    const { container } = render(
      <BackgroundTasksBar
        agents={[
          agent({
            state: "waiting",
            backgroundTasks: [
              { id: "t1", type: "local_bash", description: "codex exec migration", since },
              { id: "t2", type: "local_agent", description: "Review the diff", since },
            ],
          }),
          agent({ id: "a2", name: "Bob" }),
        ]}
      />,
    );
    const rows = container.querySelectorAll(".bg-task");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("shell");
    expect(rows[0].textContent).toContain("codex exec migration");
    expect(rows[0].textContent).toContain("3m");
    expect(rows[1].textContent).toContain("agent");
    expect(rows[0].getAttribute("title")).toBe("Alice: codex exec migration");
  });

  it("formats task kinds and elapsed times", () => {
    expect(taskTypeLabel("local_monitor")).toBe("monitor");
    expect(taskTypeLabel("remote_thing")).toBe("remote_thing");
    const now = 1_000_000;
    expect(elapsedLabel(now - 42_000, now)).toBe("42s");
    expect(elapsedLabel(now - 61 * 60_000 - 5_000, now)).toBe("1h 1m");
    expect(elapsedLabel(0, now)).toBe("");
  });
});
