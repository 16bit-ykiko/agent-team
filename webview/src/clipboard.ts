import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.addRule("fencedCodeBlock", {
  filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
  replacement: (_content, node) => {
    const code = (node as HTMLElement).querySelector("code")!;
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
