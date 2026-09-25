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

import { MdBlock, StreamingMdBlock, markdownBlocks, loadMath } from "../src/markdown";
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

describe("bare links in Chinese prose", () => {
  const links = (md: string) => {
    const { container } = render(<MdBlock>{md}</MdBlock>);
    return {
      hrefs: [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
      text: container.textContent,
    };
  };

  it("ends a bare URL at the first CJK character or full-width punctuation", () => {
    expect(links("见 https://github.com/a/b，然后看").hrefs).toEqual(["https://github.com/a/b"]);
    expect(links("https://x.com/path的说明").hrefs).toEqual(["https://x.com/path"]);
    expect(links("访问https://x.com/a.。好")).toEqual({
      hrefs: ["https://x.com/a"],
      text: "访问https://x.com/a.。好",
    });
    expect(links("www.example.com。下一句").hrefs).toEqual(["http://www.example.com"]);
  });

  it("keeps a bold URL bold", () => {
    const { container } = render(<MdBlock>{"链接：**https://x.com/a**，然后看"}</MdBlock>);
    const link = container.querySelector("strong > a")!;
    expect(link.getAttribute("href")).toBe("https://x.com/a");
    expect(container.textContent).toBe("链接：https://x.com/a，然后看");
  });

  it("links every URL GFM had folded into one", () => {
    expect(links("https://a.com，https://b.com/x。").hrefs).toEqual([
      "https://a.com",
      "https://b.com/x",
    ]);
  });

  it("keeps links whose extent is spelled out", () => {
    const wiki = "https://zh.wikipedia.org/wiki/中文";
    expect(links(`<${wiki}> 和 [中文](${wiki})`).hrefs).toEqual([encodeURI(wiki), encodeURI(wiki)]);
    expect(links("plain https://x.com/a, then").hrefs).toEqual(["https://x.com/a"]);
  });
});

describe("math", () => {
  it("renders inline and display math once KaTeX has loaded", async () => {
    const { container, findAllByText } = render(
      <MdBlock>{"Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x\\,dx\n$$"}</MdBlock>,
    );
    await loadMath();
    await findAllByText((_, el) => el?.classList.contains("katex") ?? false);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.textContent).not.toContain("$");
  });

  it("leaves prices and code alone", async () => {
    await loadMath();
    const { container } = render(<MdBlock>{"costs $5 and $10, run `echo $a$`"}</MdBlock>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("costs $5 and $10, run echo $a$");
  });

  it("renders a ```math fence as display math, not as highlighted code", async () => {
    await loadMath();
    const { container } = render(<MdBlock>{"```math\nE = mc^2\n```"}</MdBlock>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".hljs")).toBeNull();
  });

  it("renders display math with TeX on its $$ lines, and what follows as text", async () => {
    await loadMath();
    const { container } = render(
      <MdBlock>{"$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\nAfter."}</MdBlock>,
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("After.");
  });

  it("keeps splitting a streaming reply after a display block with TeX on its lines", () => {
    expect(markdownBlocks("$$x = 1 \\\\\ny = 2\n$$\n\nA\n\nB")).toHaveLength(3);
  });

  it("keeps a display block whole while streaming across a blank line", () => {
    expect(markdownBlocks("a\n\n$$\nx\n\ny\n$$\n\nb")).toEqual(["a\n", "$$\nx\n\ny\n$$\n", "b"]);
  });
});

describe("math loading", () => {
  it("retries after a failed load instead of staying raw", async () => {
    vi.resetModules();
    let fail = true;
    vi.doMock("../src/mathPlugins", async (importOriginal) => {
      if (fail) throw new Error("chunk gone");
      return importOriginal();
    });
    const { loadMath: load } = await import("../src/markdown");
    await expect(load()).rejects.toThrow();
    fail = false;
    const plugins = await load();
    expect(Array.isArray(plugins.remark)).toBe(true);
    vi.doUnmock("../src/mathPlugins");
  });
});
