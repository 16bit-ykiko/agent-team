// The transcript on narrow screens and touch: nothing said twice, nothing
// pushed off the row, no invisible tap targets over the text.
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import css from "../src/styles.css?raw";
import { EventItem, MessageItem } from "../src/chat/messages";
import type { AgentInfo, Message, StreamEvent } from "../src/state/useServer";

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
  it("names an edited file once: in the row, not again atop the body", () => {
    const ev: StreamEvent = {
      kind: "tool_use",
      toolName: "Edit",
      content: "**Edit** `src/session/claude.ts`\n```diff\n-const a = 1;\n+const a = 2;\n```",
    };
    const { container } = render(<EventItem ev={ev} />);
    expect(container.querySelector(".event-summary")!.textContent).toBe("src/session/claude.ts");
    const body = container.querySelector(".event-content")!.textContent;
    expect(body).toContain("const a = 2;");
    expect(body).not.toContain("src/session/claude.ts");
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
    expect(rule(".subagent-label").body).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".subagent-label").body).not.toMatch(/flex-shrink:\s*0/);
  });

  it("on touch, put a code block's Copy above the code, not over its first line", () => {
    const copy = rule("pre .copy-btn", "@media (hover: none)");
    expect(copy.body).toMatch(/float:\s*none/);
    expect(copy.body).toMatch(/display:\s*block/);
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

  it("colour a failed subagent's summary and an error's label as errors", () => {
    expect(rule(".subagent-failed .subagent-summary").body).toMatch(/var\(--error\)/);
    expect(rule(".banner-error .banner-label").body).toMatch(/var\(--error\)/);
  });
});
