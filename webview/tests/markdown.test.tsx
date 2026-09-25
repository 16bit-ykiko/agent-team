import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";

const parsed = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("react-markdown", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-markdown")>();
  const Counted = (props: ComponentProps<typeof real.default>) => {
    parsed.texts.push(typeof props.children === "string" ? props.children : "");
    return real.default(props);
  };
  return { ...real, default: Counted };
});

import { MdBlock, StreamingMdBlock, markdownBlocks } from "../src/markdown";
import { MessageItem } from "../src/messages";
import type { AgentInfo, Message } from "../src/useServer";

const agents: AgentInfo[] = [
  { id: "a1", name: "Alice", model: "m", avatar: "🤖", color: "#888", isDefault: true },
];

describe("links in agent markdown", () => {
  it("opens web links in a new tab and never navigates the app itself", () => {
    // Real agent output links local files; in a home-screen app a
    // same-origin href lands on "Not found" with no way back.
    const { container } = render(
      <MdBlock>
        {"See [ASTImporter.cpp:514](/home/u/llvm/ASTImporter.cpp:514) and [PR](https://x.y/pull/1)"}
      </MdBlock>,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.target, a.rel])).toEqual([
      ["https://x.y/pull/1", "_blank", "noopener noreferrer"],
    ]);
    const path = container.querySelector("code")!;
    expect(path.textContent).toBe("ASTImporter.cpp:514");
    expect(path.title).toBe("/home/u/llvm/ASTImporter.cpp:514");
  });
});

// Markdown whose top-level blocks a naive blank-line split would break.
const SAMPLE = [
  "## Plan",
  "Intro paragraph with `code`.",
  "",
  "- tight item",
  "- second",
  "",
  "- loose item after a blank",
  "",
  "  continued inside the item",
  "",
  "1. one",
  "",
  "2. two",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "    indented code",
  "",
  "    more indented code",
  "",
  "> quote",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "~~~",
  "tilde fence",
  "",
  "~~~",
  "Last paragraph.",
].join("\n");

describe("streaming markdown blocks", () => {
  it("splits only where a new top-level block starts", () => {
    // A list item or an indented line may continue what came before.
    expect(markdownBlocks("a\n\nb\n\n- x\n\n- y\n\n  z\n\nc")).toEqual([
      "a\n",
      "b\n\n- x\n\n- y\n\n  z\n",
      "c",
    ]);
    expect(markdownBlocks("```\na\n\nb\n```\n\nc")).toEqual(["```\na\n\nb\n```\n", "c"]);
    // Reference definitions resolve across the whole text, also from a quote.
    expect(markdownBlocks("see [x]\n\n[x]: https://a.b")).toHaveLength(1);
    expect(markdownBlocks("see [x]\n\n> [x]: https://a.b")).toHaveLength(1);
    // HTML blocks that run across blank lines.
    expect(markdownBlocks("a\n\n<pre>\nx\n\ny\n</pre>\n\nb")).toHaveLength(1);
  });

  it("matches one parse around HTML comments and inline triple backticks", () => {
    const same = (text: string) =>
      expect(renderToStaticMarkup(<StreamingMdBlock>{text}</StreamingMdBlock>)).toBe(
        renderToStaticMarkup(<MdBlock>{text}</MdBlock>),
      );
    same("Before.\n\n<!--\nhidden\n\nstill hidden\n-->\n\nAfter.");
    same("```x``` is inline here.\n\nText.\n\n```\ncode 1\n\ncode 2\n```\n\nEnd.");
  });

  it("renders exactly what one parse of the whole text renders, at every length", () => {
    for (let cut = 1; cut <= SAMPLE.length; cut += 7) {
      const text = SAMPLE.slice(0, cut);
      expect(renderToStaticMarkup(<StreamingMdBlock>{text}</StreamingMdBlock>)).toBe(
        renderToStaticMarkup(<MdBlock>{text}</MdBlock>),
      );
    }
  });

  it("re-parses only the last block of a growing reply", () => {
    const msg = (content: string): Message => ({
      id: "m1",
      kind: "agent",
      agentId: "a1",
      content,
      timestamp: 0,
      status: "streaming",
    });
    const head = "First paragraph.\n\n```ts\nconst a = 1;\n```\n\nSecond ";
    const { rerender } = render(<MessageItem msg={msg(head)} agents={agents} />);
    parsed.texts.length = 0;
    rerender(<MessageItem msg={msg(head + "paragraph")} agents={agents} />);
    expect(parsed.texts).toEqual(["Second paragraph"]);
  });
});

describe("code highlighting", () => {
  it("highlights fenced code in a known language", () => {
    const { container } = render(<MdBlock>{"```cpp\nint main() { return 0; }\n```"}</MdBlock>);
    const code = container.querySelector("pre code")!;
    expect(code.classList.contains("hljs")).toBe(true);
    expect(code.querySelector(".hljs-keyword, .hljs-type")).not.toBeNull();
  });

  it("styles an unknown language as code without colouring it", () => {
    const { container } = render(<MdBlock>{"```nosuchlang\nx = 1\n```"}</MdBlock>);
    const code = container.querySelector("pre code")!;
    expect(code.classList.contains("hljs")).toBe(true);
    expect(code.children).toHaveLength(0);
    expect(code.textContent).toBe("x = 1\n");
  });

  it("leaves a block without a language untouched", () => {
    const { container } = render(<MdBlock>{"```\nplain text\n```"}</MdBlock>);
    const code = container.querySelector("pre code")!;
    expect(code.className).toBe("");
    expect(code.textContent).toBe("plain text\n");
  });
});
