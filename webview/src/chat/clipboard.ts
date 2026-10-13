import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Text copies as it reads: a path keeps its underscores and backslashes.
turndown.escape = (text) => text;
turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
  replacement: (_content, node) => {
    const code = node.querySelector("code")!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ?? "";
    const text = codeText(code);
    // Longer than any run of backticks in the code, so its own ``` stay inside.
    const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `\n${fence}${lang}\n${text}\n${fence}\n`;
  },
});

// Rendered math copies back as the TeX it came from (KaTeX keeps it in a
// MathML annotation).
turndown.addRule("katex", {
  filter: (node) => node.nodeName === "SPAN" && node.classList.contains("katex"),
  replacement: (_content, node) => {
    const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    // A selection starting inside the glyphs holds no annotation: copy
    // what is visible.
    if (!tex) return node.querySelector(".katex-html")?.textContent ?? node.textContent ?? "";
    return node.parentElement?.classList.contains("katex-display")
      ? `\n\n$$\n${tex}\n$$\n\n`
      : "$" + tex + "$";
  },
});

// Very large selections make turndown janky; beyond this we let the native
// copy path handle it (plain text is fine at that size anyway).
export const MAX_COPY_HTML = 200_000;

export function selectionToMarkdown(html: string | null): string | null {
  if (!html || html.length > MAX_COPY_HTML) return null;
  try {
    return turndown.turndown(html);
  } catch {
    return null;
  }
}

// A code block's text without the line break that ends it, which pasted
// into a terminal would run the command.
export function codeText(code: Element): string {
  return (code.textContent ?? "").replace(/\r?\n$/, "");
}

// Drawn with user-select: none; Chrome still puts them in a selection's range.
const UNSELECTABLE = ".copy-btn, .step-header, .subagent-header";

function codeAround(node: Node): Element | null {
  return (node instanceof Element ? node : node.parentElement)?.closest("pre, code") ?? null;
}

// The selection as markdown, or as plain text when it is all one piece of
// code: part of a path, a few lines of a block, or the whole of either.
function selectionText(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  // Firefox splits a selection around what cannot be selected (a Copy button).
  const ranges = Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i));
  // A range per table cell (Firefox): the browser copies them as rows.
  if (ranges.length > 1 && ranges.some((range) => range.startContainer.nodeName === "TR")) {
    return null;
  }
  const div = document.createElement("div");
  for (const range of ranges) div.appendChild(range.cloneContents());
  for (const el of div.querySelectorAll(UNSELECTABLE)) el.remove();
  const around = ranges.map((range) => codeAround(range.commonAncestorContainer));
  if (around[0] && around.every((code) => code === around[0])) return codeText(div);
  // A triple click takes the start of the next block along, an empty clone.
  // A link's code holds the code it was written with.
  const codes = [...div.querySelectorAll("code")].filter(
    (code) => code.textContent?.trim() && !code.querySelector("code"),
  );
  if (codes.length === 1 && codes[0].textContent?.trim() === div.textContent?.trim()) {
    return codeText(codes[0]);
  }
  return selectionToMarkdown(div.innerHTML);
}

// Image files from a paste event's DataTransfer (Ctrl+V a screenshot).
export function extractImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

// macOS reserves clipboard shortcuts for Cmd; Ctrl+C/X/V do nothing natively
// in a browser there. Users with PC muscle memory — or an OS-level Ctrl→Cmd
// remap that doesn't reach this window (e.g. a Karabiner rule conditioned on
// browser bundle ids while the app runs as an installed PWA) — still press
// them, so mirror the Cmd behavior. Returns a cleanup function, or undefined
// off-mac where the browser already treats Ctrl as the clipboard modifier.
export function installMacCtrlClipboard(
  getFallbackTarget: () => HTMLTextAreaElement | null,
  addImages: (files: File[]) => void,
  platform: string = navigator.platform,
): (() => void) | undefined {
  if (!/Mac|iP(hone|ad|od)/.test(platform)) return undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === "c" || key === "x") {
      const el = document.activeElement;
      const editable = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
      const hasSelection = editable
        ? el.selectionStart !== el.selectionEnd
        : !(window.getSelection()?.isCollapsed ?? true);
      if (!hasSelection) return;
      e.preventDefault();
      // Goes through the copy event, so copySelectionAsMarkdown still applies.
      document.execCommand(key === "c" ? "copy" : "cut");
    } else if (key === "v") {
      // Reading the clipboard from JS needs the async clipboard API, which
      // only exists in secure contexts (https / localhost). Over plain http
      // there is nothing we can do — leave the key alone.
      if (!navigator.clipboard?.readText) return;
      e.preventDefault();
      void pasteFromClipboard(getFallbackTarget, addImages);
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

async function pasteFromClipboard(
  getFallbackTarget: () => HTMLTextAreaElement | null,
  addImages: (files: File[]) => void,
): Promise<void> {
  try {
    // Screenshots first: an image on the clipboard becomes a pending upload,
    // matching what the textarea's onPaste does for Cmd+V.
    if (navigator.clipboard.read) {
      const files: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], `clipboard.${type.split("/")[1]}`, { type }));
      }
      if (files.length > 0) {
        addImages(files);
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const el = document.activeElement;
    const target =
      el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
        ? el
        : getFallbackTarget();
    if (!target) return;
    target.focus();
    // execCommand keeps the browser's undo stack and fires a real input
    // event (so React onChange runs); fall back to manual insertion where
    // it is unsupported.
    if (!document.execCommand("insertText", false, text)) {
      target.setRangeText(text, target.selectionStart ?? 0, target.selectionEnd ?? 0, "end");
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch {
    // Clipboard permission denied — nothing to paste.
  }
}

// Copy handler for rendered-markdown containers: converts the selected HTML
// back to markdown. Ordered so that any failure (conversion error, oversized
// selection, clipboard restrictions on iOS) falls through to the browser's
// native copy instead of producing an empty clipboard — preventDefault only
// runs after the clipboard has been written successfully.
export function copySelectionAsMarkdown(e: React.ClipboardEvent): void {
  const text = selectionText();
  if (!text) return;
  try {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  } catch {
    // Native copy proceeds.
  }
}

// navigator.clipboard exists only in secure contexts (https, localhost), not
// over the LAN's plain http, and VS Code's browser may refuse it; a hidden
// textarea and execCommand still copy from a click there.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyThroughTextarea(text);
  }
}

function copyThroughTextarea(text: string): boolean {
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  // Read-only keeps a phone's keyboard down; 12pt keeps iOS from zooming in.
  area.readOnly = true;
  area.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0; font-size: 12pt;";
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}
