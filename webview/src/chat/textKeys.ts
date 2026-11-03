import { inVSCode } from "../vscode";

type Step = ["backward" | "forward", "character" | "word" | `${string}boundary`];

// The caret moves of macOS text fields. In VS Code's browser its menus can
// take one first (Option+Up is Move Line Up there): the page gets the keydown
// but the caret stays, so the move is made here. Shift extends instead.
const MOVES: Record<string, Step[]> = {
  "Meta+ArrowLeft": [["backward", "lineboundary"]],
  "Meta+ArrowRight": [["forward", "lineboundary"]],
  "Meta+ArrowUp": [["backward", "documentboundary"]],
  "Meta+ArrowDown": [["forward", "documentboundary"]],
  "Alt+ArrowLeft": [["backward", "word"]],
  "Alt+ArrowRight": [["forward", "word"]],
  // Off a paragraph's edge first, so pressing again goes on to the next one.
  "Alt+ArrowUp": [
    ["backward", "character"],
    ["backward", "paragraphboundary"],
  ],
  "Alt+ArrowDown": [
    ["forward", "character"],
    ["forward", "paragraphboundary"],
  ],
};

const DELETES: Record<string, Step> = {
  "Meta+Backspace": ["backward", "lineboundary"],
  "Meta+Delete": ["forward", "lineboundary"],
  "Alt+Backspace": ["backward", "word"],
  "Alt+Delete": ["forward", "word"],
};

// Returns a cleanup function, or undefined where the browser's own keys work.
export function installMacTextKeys(
  platform: string = navigator.platform,
  ua: string = navigator.userAgent,
): (() => void) | undefined {
  if (!/Mac/.test(platform) || !inVSCode(ua)) return undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey) return;
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
    const sel = window.getSelection();
    if (!sel) return;
    const chord = `${e.metaKey ? "Meta+" : ""}${e.altKey ? "Alt+" : ""}${e.key}`;
    const moves = MOVES[chord];
    if (moves) {
      for (const [direction, granularity] of moves) {
        sel.modify(e.shiftKey ? "extend" : "move", direction, granularity);
      }
      e.preventDefault();
      return;
    }
    const deletion = DELETES[chord];
    if (!deletion || e.shiftKey) return;
    const [direction, granularity] = deletion;
    if (el.selectionStart === el.selectionEnd) sel.modify("extend", direction, granularity);
    // Through the editor, so it can be undone. Where nothing was taken in (at
    // a line's edge) the character beyond goes, joining the lines as on macOS.
    if (document.execCommand(direction === "backward" ? "delete" : "forwardDelete")) {
      e.preventDefault();
    }
  };

  // Capture before React or another component can stop propagation.
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
