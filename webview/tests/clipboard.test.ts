import { describe, it, expect, vi, afterEach } from "vitest";
import {
  installMacCtrlClipboard,
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

describe("installMacCtrlClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const press = (key: string, over: Partial<KeyboardEventInit> = {}) => {
    const e = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true, ...over });
    window.dispatchEvent(e);
    return e;
  };

  it("is a no-op off macOS", () => {
    expect(
      installMacCtrlClipboard(
        () => null,
        () => {},
        "Linux x86_64",
      ),
    ).toBeUndefined();
  });

  it("copies via execCommand on Ctrl+C with a textarea selection", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec as typeof document.execCommand;
    const ta = document.createElement("textarea");
    ta.value = "hello";
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, 5);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
    )!;
    const e = press("c");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("leaves Ctrl+C alone without a selection (and Cmd combos alone entirely)", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec as typeof document.execCommand;
    const cleanup = installMacCtrlClipboard(
      () => null,
      () => {},
      "MacIntel",
    )!;

    expect(press("c").defaultPrevented).toBe(false);
    expect(press("c", { metaKey: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    cleanup();
  });

  it("pastes clipboard text into the fallback textarea on Ctrl+V", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: "MacIntel",
      clipboard: { readText: async () => "pasted" },
    });
    const exec = vi.fn(() => false); // force the setRangeText fallback
    document.execCommand = exec as typeof document.execCommand;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
    )!;
    const e = press("v");
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ta.value).toBe("pasted"));
    cleanup();
  });

  it("does not hijack Ctrl+V when the async clipboard API is unavailable", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const cleanup = installMacCtrlClipboard(
      () => null,
      () => {},
      "MacIntel",
    )!;
    expect(press("v").defaultPrevented).toBe(false);
    cleanup();
  });

  it("turns clipboard images into pending uploads instead of text", async () => {
    const blob = new Blob(["img"], { type: "image/png" });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        readText: async () => "ignored",
        read: async () => [{ types: ["image/png"], getType: async () => blob }],
      },
    });
    const added: File[][] = [];
    const cleanup = installMacCtrlClipboard(
      () => null,
      (f) => added.push(f),
      "MacIntel",
    )!;
    press("v");
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0][0].type).toBe("image/png");
    cleanup();
  });
});
