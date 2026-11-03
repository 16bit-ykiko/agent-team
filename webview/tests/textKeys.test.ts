import { describe, it, expect, vi, afterEach } from "vitest";
import { installMacTextKeys } from "../src/chat/textKeys";

const VSCODE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.140.0 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";

// jsdom has no Selection.modify: the steps asked for are recorded.
function setup(value = "one two\nthree") {
  const modify = vi.fn();
  vi.stubGlobal("getSelection", () => ({ modify }));
  const exec = vi.fn(() => true);
  document.execCommand = exec;
  const ta = document.createElement("textarea");
  ta.value = value;
  document.body.appendChild(ta);
  ta.focus();
  const cleanup = installMacTextKeys("MacIntel", VSCODE_UA)!;
  return { ta, modify, exec, cleanup };
}

const press = (key: string, over: Partial<KeyboardEventInit>) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...over });
  (document.activeElement ?? window).dispatchEvent(e);
  return e;
};

describe("installMacTextKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("only takes the keys in VS Code on a Mac", () => {
    expect(installMacTextKeys("MacIntel", "Mozilla/5.0 (Macintosh) Chrome/138.0")).toBeUndefined();
    expect(installMacTextKeys("Win32", VSCODE_UA)).toBeUndefined();
  });

  it("moves the caret by line, document, word and paragraph, Shift extending", () => {
    const { modify, cleanup } = setup();
    const keys: Array<[string, Partial<KeyboardEventInit>]> = [
      ["ArrowLeft", { metaKey: true }],
      ["ArrowRight", { metaKey: true, shiftKey: true }],
      ["ArrowUp", { metaKey: true }],
      ["ArrowDown", { metaKey: true, shiftKey: true }],
      ["ArrowLeft", { altKey: true }],
      ["ArrowRight", { altKey: true, shiftKey: true }],
      ["ArrowUp", { altKey: true }],
      ["ArrowDown", { altKey: true, shiftKey: true }],
    ];
    for (const [key, mods] of keys) expect(press(key, mods).defaultPrevented).toBe(true);
    expect(modify.mock.calls).toEqual([
      ["move", "backward", "lineboundary"],
      ["extend", "forward", "lineboundary"],
      ["move", "backward", "documentboundary"],
      ["extend", "forward", "documentboundary"],
      ["move", "backward", "word"],
      ["extend", "forward", "word"],
      ["move", "backward", "character"],
      ["move", "backward", "paragraphboundary"],
      ["extend", "forward", "character"],
      ["extend", "forward", "paragraphboundary"],
    ]);
    cleanup();
  });

  it("deletes to the line's start or a word through the editor, a selection as it is", () => {
    const { ta, modify, exec, cleanup } = setup();
    ta.setSelectionRange(5, 5);
    expect(press("Backspace", { metaKey: true }).defaultPrevented).toBe(true);
    expect(press("Delete", { altKey: true }).defaultPrevented).toBe(true);
    ta.setSelectionRange(0, 3);
    expect(press("Backspace", { altKey: true }).defaultPrevented).toBe(true);
    expect(modify.mock.calls).toEqual([
      ["extend", "backward", "lineboundary"],
      ["extend", "forward", "word"],
    ]);
    expect(exec.mock.calls).toEqual([["delete"], ["forwardDelete"], ["delete"]]);
    cleanup();
  });

  it("leaves other keys, other fields and a composing input method alone", () => {
    const { modify, exec, cleanup } = setup();
    expect(press("ArrowLeft", {}).defaultPrevented).toBe(false);
    expect(press("ArrowUp", { metaKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(press("ArrowLeft", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("ArrowLeft", { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(press("Backspace", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    (document.activeElement as HTMLElement).blur();
    expect(press("ArrowLeft", { metaKey: true }).defaultPrevented).toBe(false);
    expect(modify).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    cleanup();
  });
});
