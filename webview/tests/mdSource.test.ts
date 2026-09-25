import { describe, it, expect } from "vitest";
import { prepareSource } from "../src/mdSource";

const text = (md: string) => prepareSource(md).text;
const unchanged = (md: string) =>
  expect(prepareSource(md), md).toEqual({ text: md, hasMath: false });

describe("math in the source", () => {
  it("turns a $…$ pair that reads as math into inline math", () => {
    expect(prepareSource("area $\\pi r^2$ here")).toEqual({
      text: "area $$\\pi r^2$$ here",
      hasMath: true,
    });
    for (const [src, out] of [
      ["$x$", "$$x$$"],
      ["$a + b$ and $O(n log n)$", "$$a + b$$ and $$O(n log n)$$"],
      ["长度为$n$的数组", "长度为$$n$$的数组"],
      ["SiO$_2$ at 25$^\\circ$C", "SiO$$_2$$ at 25$$^\\circ$$C"],
      ["0.20$\\sim$0.25 cm$^3$/g", "0.20$$\\sim$$0.25 cm$$^3$$/g"],
    ]) {
      expect(text(src), src).toBe(out);
    }
  });

  // Real replies: most $…$ pairs are not math.
  it("leaves prices, shell variables, templates and identifiers as text", () => {
    unchanged("costs $5 and $10");
    unchanged("set $HOME and $PATH");
    unchanged("path: $T/$d/.clice");
    unchanged('rewrite it as "${T:?}"/"${d:?}"');
    unchanged('{"$ref": "#/$defs/Node"}');
    unchanged(".debug$S section while keeping .debug$T");
    unchanged("现有的 $() 和 @[] 语法都有问题($ 用于变量)");
    unchanged('write "$x$" for inline math');
    unchanged("${a} and ${b}");
    unchanged("hash(${pkg.version}_${nodeVersion}_${x})");
  });

  it("rewrites \\( \\) inline and a lone \\[ \\] line as a display block", () => {
    expect(text("so \\(a_1\\) holds")).toBe("so $$a_1$$ holds");
    expect(text("- sum:\n  \\[ \\sum_i x_i \\]\n")).toBe("- sum:\n  $$\n  \\sum_i x_i\n  $$\n");
    expect(text("\\[\nE = mc^2\n\\]")).toBe("$$\nE = mc^2\n$$");
  });

  it("puts display fences on lines of their own", () => {
    expect(text("$$x^2$$")).toBe("$$\nx^2\n$$");
    expect(text("$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\nAfter.")).toBe(
      "$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$\n\nAfter.",
    );
    expect(text("$$x = 1 \\\\\ny = 2\n$$")).toBe("$$\nx = 1 \\\\\ny = 2\n$$");
    expect(text("$$\na\n\nb\n$$")).toBe("$$\na\n\nb\n$$");
    expect(text("a $$x^2$$ b")).toBe("a $$x^2$$ b");
  });

  it("escapes an unpaired $$ so it cannot swallow the rest of the reply", () => {
    expect(text("$$ some text\n\nlater $x$")).toBe("\\$\\$ some text\n\nlater $$x$$");
  });

  it("keeps escaped brackets that are not TeX", () => {
    unchanged("*\\[interrupted\\]* and a\\[0\\]");
  });

  it("does not touch code", () => {
    unchanged("run `echo $a$b` then\n\n```sh\necho $x$ \\(y\\)\n```\n");
    unchanged("> ~~~\n> echo $a$b\n> ~~~");
    unchanged("~~~sh\r\necho $a$b\r\n~~~\r\n");
    // An unmatched backtick does not reach past its paragraph.
    expect(text("It`s $x$ fine\n\nand `code $a$b`")).toBe("It`s $$x$$ fine\n\nand `code $a$b`");
  });

  it("reports a ```math fence as math", () => {
    expect(prepareSource("```math\nE=mc^2\n```").hasMath).toBe(true);
  });

  it("does not throw on truncated input", () => {
    for (const s of [
      "\\",
      "$",
      "$$",
      "`",
      "```",
      "\\[",
      "\\(",
      "$a",
      "$$a",
      "\\[a",
      "a\\",
      "$\\",
    ]) {
      expect(() => prepareSource(s)).not.toThrow();
    }
  });
});

describe("bare URLs in the source", () => {
  it("ends a bare URL where Chinese text begins, as an explicit autolink", () => {
    expect(text("见 https://github.com/a/b，然后看")).toBe("见 <https://github.com/a/b>，然后看");
    expect(text("https://x.com/path的说明")).toBe("<https://x.com/path>的说明");
    expect(text("访问https://x.com/a.。好")).toBe("访问<https://x.com/a>.。好");
    expect(text("www.example.com。下一句")).toBe(
      "[www.example.com](http://www.example.com)。下一句",
    );
    expect(text("https://a.com，https://b.com/x。")).toBe("<https://a.com>，<https://b.com/x>。");
  });

  it("keeps emphasis around the URL paired", () => {
    expect(text("链接：**https://x.com/a**，然后看")).toBe("链接：**<https://x.com/a>**，然后看");
    expect(text("**http://localhost:5173/a**(状态 200)")).toBe(
      "**<http://localhost:5173/a>**(状态 200)",
    );
  });

  it("stops at curly quotes, dashes and ellipses", () => {
    expect(text("见“https://x.com/a”，然后")).toBe("见“<https://x.com/a>”，然后");
    expect(text("https://x.com/a——然后")).toBe("<https://x.com/a>——然后");
  });

  it("never takes $ inside a URL for math", () => {
    unchanged("GET https://graph.microsoft.com/v1.0/me/messages?$select=subject&$top=5 now");
    unchanged("see [docs](https://example.com/$v$/x)");
  });

  it("leaves links that spell out their extent", () => {
    unchanged("<https://zh.wikipedia.org/wiki/中文> 和 [中文](https://zh.wikipedia.org/wiki/中文)");
    unchanged("plain https://x.com/a, then");
  });
});

describe("cost", () => {
  const time = (md: string) => {
    const t = performance.now();
    prepareSource(md);
    return performance.now() - t;
  };

  it("stays linear on adversarial text", () => {
    for (const md of [
      "\\(a ".repeat(20_000),
      "$a ".repeat(12_000),
      "$$x$$\n".repeat(20_000),
      "``a ```b ````c ".repeat(20_000),
      "$$a$$ b\n".repeat(20_000),
      "https://x.com/中".repeat(10_000),
    ]) {
      expect(time(md), md.slice(0, 12)).toBeLessThan(300);
    }
  });
});
