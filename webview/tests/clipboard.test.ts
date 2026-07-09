import { describe, it, expect, vi, afterEach } from "vitest";
import {
  selectionToMarkdown,
  copySelectionAsMarkdown,
  extractImageFiles,
  MAX_COPY_HTML,
} from "../src/clipboard";

function mockSelection(html: string | null) {
  const getSelection = vi.fn(() => {
    if (html === null) return { isCollapsed: true } as unknown as Selection;
    return {
      isCollapsed: false,
      getRangeAt: () => ({
        cloneContents: () => {
          const div = document.createElement("div");
          div.innerHTML = html;
          const frag = document.createDocumentFragment();
          while (div.firstChild) frag.appendChild(div.firstChild);
          return frag;
        },
      }),
    } as unknown as Selection;
  });
  vi.stubGlobal("getSelection", getSelection);
}

function makeEvent(setDataImpl?: () => void) {
  return {
    clipboardData: { setData: vi.fn(setDataImpl) },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent & {
    clipboardData: { setData: ReturnType<typeof vi.fn> };
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectionToMarkdown", () => {
  it("converts rendered HTML back to markdown, keeping code fences", () => {
    const md = selectionToMarkdown(
      '<p>Use <strong>bold</strong></p><pre><code class="language-ts">const a = 1;</code></pre>',
    );
    expect(md).toContain("**bold**");
    expect(md).toContain("```ts\nconst a = 1;\n```");
  });

  it("returns null for empty or oversized selections", () => {
    expect(selectionToMarkdown(null)).toBeNull();
    expect(selectionToMarkdown("")).toBeNull();
    expect(selectionToMarkdown("<p>" + "x".repeat(MAX_COPY_HTML) + "</p>")).toBeNull();
  });
});

describe("copySelectionAsMarkdown", () => {
  it("writes markdown to the clipboard and suppresses the native copy", () => {
    mockSelection("<p><em>hi</em> there</p>");
    const e = makeEvent();
    copySelectionAsMarkdown(e);
    expect(e.clipboardData.setData).toHaveBeenCalledWith("text/plain", "_hi_ there");
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("does nothing for a collapsed selection", () => {
    mockSelection(null);
    const e = makeEvent();
    copySelectionAsMarkdown(e);
    expect(e.clipboardData.setData).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("falls back to native copy when the clipboard write throws", () => {
    // iOS Safari can reject programmatic clipboard writes; the old code
    // called preventDefault first, so a failure left the clipboard empty.
    mockSelection("<p>text</p>");
    const e = makeEvent(() => {
      throw new Error("denied");
    });
    copySelectionAsMarkdown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves huge selections to the native copy path", () => {
    mockSelection("<p>" + "x".repeat(MAX_COPY_HTML) + "</p>");
    const e = makeEvent();
    copySelectionAsMarkdown(e);
    expect(e.clipboardData.setData).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("extractImageFiles", () => {
  function dt(items: Array<{ kind: string; type: string; file?: File | null }>): DataTransfer {
    return {
      items: items.map((i) => ({
        kind: i.kind,
        type: i.type,
        getAsFile: () => i.file ?? null,
      })),
    } as unknown as DataTransfer;
  }

  it("returns image files from a paste and ignores text items", () => {
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const files = extractImageFiles(
      dt([
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png", file: png },
        { kind: "file", type: "application/pdf", file: new File([], "doc.pdf") },
      ]),
    );
    expect(files).toEqual([png]);
  });

  it("handles null DataTransfer and file items without a file", () => {
    expect(extractImageFiles(null)).toEqual([]);
    expect(extractImageFiles(dt([{ kind: "file", type: "image/png", file: null }]))).toEqual([]);
  });
});
