import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
  replacement: (_content, node) => {
    const code = node.querySelector("code")!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ?? "";
    return `\n\`\`\`${lang}\n${code.textContent}\n\`\`\`\n`;
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

function getSelectionHtml(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const frag = sel.getRangeAt(0).cloneContents();
  const div = document.createElement("div");
  div.appendChild(frag);
  return div.innerHTML;
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
  const md = selectionToMarkdown(getSelectionHtml());
  if (md === null) return;
  try {
    e.clipboardData.setData("text/plain", md);
    e.preventDefault();
  } catch {
    // Native copy proceeds.
  }
}
