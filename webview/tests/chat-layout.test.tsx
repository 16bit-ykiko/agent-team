// The transcript on narrow screens and touch: nothing said twice, nothing
// pushed off the row, no invisible tap targets over the text.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import css from "../src/styles.css?raw";
import { EventItem, MessageItem, SubAgentItem } from "../src/chat/messages";
import type { AgentInfo, Message, StreamEvent, SubAgentInfo } from "../src/state/useServer";

const agent: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#888",
  isDefault: true,
};

const withSheet = (fn: () => void) => {
  const sheet = document.createElement("style");
  sheet.textContent = css;
  document.head.appendChild(sheet);
  try {
    fn();
  } finally {
    sheet.remove();
  }
};

describe("the transcript", () => {
  it("names an edited file once: in its block under the row, not again atop the diff", () => {
    const ev: StreamEvent = {
      kind: "tool_use",
      toolName: "Edit",
      content: "**Edit** `src/session/claude.ts`\n```diff\n-const a = 1;\n+const a = 2;\n```",
    };
    const { container } = render(<EventItem ev={ev} />);
    expect(container.querySelector(".event-summary-line")!.textContent).toBe(
      "src/session/claude.ts",
    );
    const body = container.querySelector(".event-content")!.textContent;
    expect(body).toContain("const a = 2;");
    expect(body).not.toContain("src/session/claude.ts");
  });

  it("writes a file tool's path out whole in a block under its row, the row keeping the tool's name", () => {
    const path = "/home/ykiko/workspace/agent-team/webview/src/chat/messages.tsx";
    const write = render(
      <EventItem
        ev={{
          kind: "tool_use",
          toolName: "Write",
          content: `**Write** \`${path}\`\n\`\`\`tsx\nexport {};\n\`\`\``,
        }}
      />,
    ).container;
    expect(write.querySelector(".event-row .event-chip")!.textContent).toBe("Write");
    expect(write.querySelector(".event-summary-line code")!.textContent).toBe(path);
    // The body is the file's content, without the path again.
    expect(write.querySelector(".event-content")!.textContent).not.toContain(path);
    // A Bash call has no summary: its command is the body already.
    const bash = render(
      <EventItem
        ev={{ kind: "tool_use", toolName: "Bash", content: "**Bash**\n```bash\nls\n```" }}
      />,
    ).container;
    expect(bash.querySelector(".event-summary-line")).toBeNull();
  });

  it("shows how long each tool call and task ran, a quick one in milliseconds", () => {
    const call = (durationMs?: number) =>
      render(
        <EventItem
          ev={{
            kind: "tool_use",
            toolName: "Bash",
            content: "**Bash**\n```bash\nmake\n```",
            toolResult: "ok",
            ...(durationMs != null && { durationMs }),
          }}
        />,
      ).container.querySelector(".event-row .event-time")?.textContent ?? null;
    expect(call(4230)).toBe("4.2s");
    expect(call(38)).toBe("38ms");
    // Recorded before it was measured: nothing, not "0ms".
    expect(call()).toBeNull();
    const card = render(
      <SubAgentItem
        ev={{
          kind: "subagent_start",
          content: "",
          subagent: {
            taskId: "b1",
            description: "sleep 6",
            agentType: "shell",
            taskType: "local_bash",
            status: "completed",
            durationMs: 6004,
            events: [],
          },
        }}
      />,
    ).container;
    expect(card.querySelector(".subagent-header .subagent-time")!.textContent).toBe("6s");
    // A thinking block keeps its own time, in its label.
    const thought = render(
      <EventItem ev={{ kind: "thinking", content: "hm", durationMs: 2700 }} />,
    );
    expect(thought.container.querySelector(".event-time")).toBeNull();
  });

  it("gives a card one time: this run's, or a finished agent's from the CLI on old records", () => {
    const agentCard = (sa: Partial<SubAgentInfo>) =>
      render(
        <SubAgentItem
          ev={{
            kind: "subagent_start",
            content: "",
            subagent: {
              taskId: "a1",
              description: "look",
              agentType: "Explore",
              status: "completed",
              events: [{ kind: "text", content: "found" }],
              ...sa,
            },
          }}
        />,
      ).container;
    const time = (c: HTMLElement) => c.querySelector(".subagent-time")?.textContent ?? null;
    const usage = { totalTokens: 14_000, toolUses: 3, durationMs: 43_600 };
    // Resumed: the CLI counts from the first run, idle time included.
    const resumed = agentCard({ usage, durationMs: 27_800 });
    expect(time(resumed)).toBe("27.8s");
    fireEvent.click(resumed.querySelector(".subagent-header")!);
    expect(resumed.querySelector(".subagent-usage")!.textContent).toBe("14k tokens · 3 tools");
    expect(time(agentCard({ usage }))).toBe("43.6s");
    expect(time(agentCard({ usage, status: "running" }))).toBeNull();
  });

  it("keeps the quote button in the header row, off the text", () => {
    const msg: Message = {
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content: "Done: the tests pass.",
      timestamp: 0,
      status: "done",
    };
    const { container } = render(<MessageItem msg={msg} agents={[agent]} onQuote={vi.fn()} />);
    expect(container.querySelector(".message-header .btn-quote")).not.toBeNull();
    expect(container.querySelector(".message-content .btn-quote")).toBeNull();
    withSheet(() => {
      const quote = getComputedStyle(container.querySelector(".btn-quote")!);
      expect(quote.position).not.toBe("absolute");
      expect(quote.marginLeft).toBe("auto");
    });
  });

  it("cuts a long sender's name on one line instead of wrapping it", () => {
    const msg: Message = {
      id: "m2",
      kind: "user",
      agentId: null,
      content: "carry on",
      timestamp: 0,
      status: "done",
      from: {
        workspaceId: "w1",
        name: "fix the wake-up time the CLI rounds up to the minute",
        role: "worker",
      },
    };
    const { container } = render(<MessageItem msg={msg} agents={[agent]} />);
    withSheet(() => {
      const name = getComputedStyle(container.querySelector(".from-author")!);
      expect([name.whiteSpace, name.textOverflow, name.overflow]).toEqual([
        "nowrap",
        "ellipsis",
        "hidden",
      ]);
    });
    // A button centres its text: the name starts where the header does.
    expect(css).toMatch(/\.from-author \{[^}]*text-align: left;/);
  });
});

describe("the transcript's rules", () => {
  interface Rule {
    selectors: string[];
    body: string;
    media: string | null;
  }
  const rules = (text: string, media: string | null = null): Rule[] => {
    const out: Rule[] = [];
    const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@media")) out.push(...rules(body, head));
      else out.push({ selectors: head.split(",").map((s) => s.trim()), body, media });
      i = j;
    }
    return out;
  };
  const all = rules(css);
  const rule = (sel: string, media: string | null = null) =>
    all.find((r) => r.selectors.includes(sel) && r.media === media)!;

  it("let a long tool name or subagent type give way to the buttons beside it", () => {
    expect(rule(".event-chip").body).toMatch(/flex-shrink:\s*1/);
    // A phone wraps a row's time and buttons rather than push them off it.
    const phone = "@media (max-width: 768px), (max-height: 500px)";
    expect(rule(".event-row", phone).body).toMatch(/flex-wrap:\s*wrap/);
    // A path or pattern is a block of its own, whole, on every screen.
    expect(rule(".event-summary-line").body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".event-summary-line").body).not.toMatch(/display:\s*none/);
    expect(rule(".subagent-label").body).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".subagent-label").body).not.toMatch(/flex-shrink:\s*0/);
  });

  it("float a code block's Copy over its corner, taking no room from the code", () => {
    const copy = rule("pre .copy-btn");
    expect(copy.body).toMatch(/float:\s*right/);
    // Positioned, so it is drawn above the text it overlaps.
    expect(copy.body).toMatch(/position:\s*sticky/);
    // No width or height left for the text to wrap around.
    expect(copy.body).toMatch(/margin:\s*-4px -6px -100% -100%/);
    // On touch it stays faintly visible; nothing moves it off the code.
    const touch = all.filter((r) => r.selectors.some((s) => s.includes(".copy-btn")) && r.media);
    expect(touch.map((r) => r.body.trim())).toEqual(["opacity: 0.6;"]);
  });

  it("keep images their own shape, and a queued message's ✕ a target bigger than its glyph", () => {
    expect(rule(".msg-images").body).toMatch(/align-items:\s*flex-start/);
    expect(rule(".queued-cancel").body).toMatch(/padding:\s*6px/);
  });

  it("give a command's description a line of its own on phones", () => {
    const phone = "@media (max-width: 768px), (max-height: 500px)";
    expect(rule(".command-item", phone).body).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".command-desc", phone).body).toMatch(/flex-basis:\s*100%/);
  });

  it("give a phone's branch line room for the branch: the PR goes by its number", () => {
    const phone = "@media (max-width: 768px), (max-height: 500px)";
    expect(rule(".pr-title", phone).body).toMatch(/display:\s*none/);
    expect(rule(".pr-state", phone).body).toMatch(/display:\s*none/);
    expect(rule(".pr-card", phone).body).toMatch(/flex-shrink:\s*0/);
    expect(rule(".pr-open .pr-number", phone).body).toMatch(/var\(--success\)/);
    expect(rule(".ws-info-branch", phone).body).toMatch(/min-width:\s*6em/);
  });

  it("colour a failed subagent's summary and an error's label as errors", () => {
    expect(rule(".subagent-failed .subagent-summary").body).toMatch(/var\(--error\)/);
    expect(rule(".banner-error .banner-label").body).toMatch(/var\(--error\)/);
  });
});
