import { describe, it, expect, vi, afterEach } from "vitest";
import {
  installMacCtrlClipboard,
  selectionToMarkdown,
  copySelectionAsMarkdown,
  extractImageFiles,
  MAX_COPY_HTML,
} from "../src/chat/clipboard";

function mockSelection(html: string | null) {
  const getSelection = vi.fn(() => {
    if (html === null) return { isCollapsed: true } as unknown as Selection;
    return {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({
        commonAncestorContainer: document.body,
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
  const setData = vi.fn(setDataImpl);
  const preventDefault = vi.fn();
  const e = { clipboardData: { setData }, preventDefault } as unknown as React.ClipboardEvent;
  return { e, setData, preventDefault };
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
    const { e, setData, preventDefault } = makeEvent();
    copySelectionAsMarkdown(e);
    expect(setData).toHaveBeenCalledWith("text/plain", "_hi_ there");
    expect(preventDefault).toHaveBeenCalled();
  });

  it("does nothing for a collapsed selection", () => {
    mockSelection(null);
    const { e, setData, preventDefault } = makeEvent();
    copySelectionAsMarkdown(e);
    expect(setData).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("falls back to native copy when the clipboard write throws", () => {
    // iOS Safari can reject programmatic clipboard writes; the old code
    // called preventDefault first, so a failure left the clipboard empty.
    mockSelection("<p>text</p>");
    const { e, preventDefault } = makeEvent(() => {
      throw new Error("denied");
    });
    copySelectionAsMarkdown(e);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("leaves huge selections to the native copy path", () => {
    mockSelection("<p>" + "x".repeat(MAX_COPY_HTML) + "</p>");
    const { e, setData, preventDefault } = makeEvent();
    copySelectionAsMarkdown(e);
    expect(setData).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
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

const VSCODE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.140.0 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";

describe("installMacCtrlClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const press = (
    key: string,
    over: Partial<KeyboardEventInit> = { ctrlKey: true },
    target: Window | HTMLElement = window,
  ) => {
    const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...over });
    target.dispatchEvent(e);
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
    document.execCommand = exec;
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
    const e = press("c", { ctrlKey: true });
    expect(exec).toHaveBeenCalledWith("copy");
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("copies via execCommand on Cmd+C before a child can stop propagation", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const ta = document.createElement("textarea");
    ta.value = "hello";
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, 5);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    const e = press("c", { metaKey: true }, ta);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("selects all textarea text on Ctrl+A", () => {
    const ta = document.createElement("textarea");
    ta.value = "select all of this";
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(4, 8);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
    )!;
    const e = press("a", { ctrlKey: true });
    expect(ta.selectionStart).toBe(0);
    expect(ta.selectionEnd).toBe(ta.value.length);
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("selects page content via execCommand on Cmd+A", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;

    const cleanup = installMacCtrlClipboard(
      () => null,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    const e = press("a", { metaKey: true });
    expect(exec).toHaveBeenCalledWith("selectAll");
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("undoes and redoes in a focused textarea on Cmd+Z and Cmd+Shift+Z, Ctrl too", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    expect(press("z", { metaKey: true }).defaultPrevented).toBe(true);
    expect(press("Z", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(press("Z", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    // Yank, in a macOS text field.
    expect(press("y", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(exec.mock.calls).toEqual([["undo"], ["redo"], ["redo"]]);
    cleanup();
  });

  it("leaves undo to the page outside a text field", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const cleanup = installMacCtrlClipboard(
      () => null,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    expect(press("z", { metaKey: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    cleanup();
  });

  it("leaves clipboard shortcuts alone without a selection or with mixed modifiers", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const cleanup = installMacCtrlClipboard(
      () => null,
      () => {},
      "MacIntel",
    )!;

    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("c", { ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    cleanup();
  });

  it("pastes synchronously on Cmd+V when the webview host supports execCommand", () => {
    const exec = vi.fn((command: string) => command === "paste");
    document.execCommand = exec;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    const e = press("v", { metaKey: true });
    expect(ta).toBe(document.activeElement);
    expect(exec).toHaveBeenCalledWith("paste");
    expect(e.defaultPrevented).toBe(true);
    cleanup();
  });

  it("pastes from the clipboard on Cmd+V in VS Code when execCommand cannot", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: "MacIntel",
      clipboard: { readText: () => Promise.resolve("pasted") },
    });
    document.execCommand = vi.fn(() => false);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    expect(press("v", { metaKey: true }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ta.value).toBe("pasted"));
    cleanup();
  });

  it("leaves Cmd's shortcuts to any other Mac browser, Ctrl's still taken", () => {
    const readText = vi.fn(() => Promise.resolve("pasted"));
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", clipboard: { readText } });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
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
    for (const key of ["c", "x", "v", "a", "z"]) {
      expect(press(key, { metaKey: true }).defaultPrevented).toBe(false);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    cleanup();
  });

  it("leaves the keys alone while an input method composes", () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
      VSCODE_UA,
    )!;
    expect(press("z", { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(press("a", { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    cleanup();
  });

  it("pastes clipboard text into the fallback textarea on Ctrl+V", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: "MacIntel",
      clipboard: { readText: () => Promise.resolve("pasted") },
    });
    const exec = vi.fn(() => false); // force the setRangeText fallback
    document.execCommand = exec;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    const cleanup = installMacCtrlClipboard(
      () => ta,
      () => {},
      "MacIntel",
    )!;
    const e = press("v", { ctrlKey: true });
    expect(exec).toHaveBeenCalledWith("paste");
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
    expect(press("v", { ctrlKey: true }).defaultPrevented).toBe(false);
    cleanup();
  });

  it("turns clipboard images into pending uploads instead of text", async () => {
    const blob = new Blob(["img"], { type: "image/png" });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        readText: () => Promise.resolve("ignored"),
        read: () =>
          Promise.resolve([{ types: ["image/png"], getType: () => Promise.resolve(blob) }]),
      },
    });
    const added: File[][] = [];
    const cleanup = installMacCtrlClipboard(
      () => null,
      (f) => added.push(f),
      "MacIntel",
    )!;
    press("v", { ctrlKey: true });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0][0].type).toBe("image/png");
    cleanup();
  });
});

describe("copying rendered math", () => {
  it("gives back the TeX, inline and display", async () => {
    const katex = (await import("katex")).default;
    const inline = katex.renderToString("x^2");
    const block = katex.renderToString("\\int_0^1 x\\,dx", { displayMode: true });
    expect(selectionToMarkdown(`<p>area ${inline} here</p>${block}`)).toBe(
      "area $x^2$ here\n\n$$\n\\int_0^1 x\\,dx\n$$",
    );
  });

  it("copies the visible glyphs of a partly selected formula", async () => {
    const katex = (await import("katex")).default;
    const div = document.createElement("div");
    div.innerHTML = katex.renderToString("x^2");
    div.querySelector(".katex-mathml")!.remove();
    expect(selectionToMarkdown(div.innerHTML)).toBe("x2");
  });
});
