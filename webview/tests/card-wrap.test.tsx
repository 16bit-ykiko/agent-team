// A background shell's command in its card wraps like a tool call in the
// steps, instead of one long bar to scroll.
import { it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import css from "../src/styles.css?raw";
import { SubAgentItem } from "../src/App";

it("wraps a long command in a background task's card, as in the steps", () => {
  const sheet = document.createElement("style");
  sheet.textContent = css;
  document.head.appendChild(sheet);
  try {
    const command = `npm run build && ${"node scripts/check.ts --all ".repeat(20)}`;
    const { container } = render(
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "b1",
            description: "build everything",
            taskType: "local_bash",
            status: "running",
            prompt: `\`\`\`bash\n${command}\n\`\`\``,
          },
        }}
      />,
    );
    fireEvent.click(container.querySelector(".subagent-header")!);
    const pre = container.querySelector(".subagent-prompt pre")!;
    expect(pre.textContent).toContain("node scripts/check.ts");
    expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");
    const step = document.createElement("div");
    step.className = "event-content";
    step.innerHTML = "<pre>x</pre>";
    document.body.appendChild(step);
    expect(getComputedStyle(step.querySelector("pre")!).whiteSpace).toBe(
      getComputedStyle(pre).whiteSpace,
    );
    step.remove();
  } finally {
    sheet.remove();
  }
});
