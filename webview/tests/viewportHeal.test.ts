import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import {
  ViewportTracker,
  healViewport,
  isAtBottom,
  isTextInput,
  settleScroller,
} from "../src/viewportHeal";

describe("ViewportTracker", () => {
  it("remembers the tallest viewport seen and flags a lasting shrink", () => {
    const t = new ViewportTracker(852);
    t.observe(852);
    expect(t.needsHeal(852, false)).toBe(false);
    // Keyboard up: shrink is expected, do not heal.
    expect(t.needsHeal(500, true)).toBe(false);
    // Keyboard down but still 59px short: the iOS standalone bug.
    expect(t.needsHeal(793, false)).toBe(true);
    // Rounding noise is not a bug.
    expect(t.needsHeal(850, false)).toBe(false);
    t.observe(900);
    expect(t.maxHeight).toBe(900);
  });

  it("can be seeded above the current height so a reload into the bug still heals", () => {
    // Page loaded with the viewport already shrunk (812 of a 874px screen).
    const t = new ViewportTracker(Math.max(812, 874));
    expect(t.needsHeal(812, false)).toBe(true);
  });
});

describe("healViewport", () => {
  it("forces a re-layout of the shell and restores the scroll position", () => {
    const shell = document.createElement("div");
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollTop", { value: 120, writable: true });
    healViewport(shell, scroller);
    expect(shell.style.display).toBe("");
    expect(scroller.scrollTop).toBe(120);
    expect(() => healViewport(null, null)).not.toThrow();
  });
});

describe("isTextInput", () => {
  it("recognises the fields that summon the software keyboard", () => {
    expect(isTextInput(document.createElement("textarea"))).toBe(true);
    expect(isTextInput(document.createElement("input"))).toBe(true);
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTextInput(editable)).toBe(true);
    expect(isTextInput(document.createElement("button"))).toBe(false);
    expect(isTextInput(document.body)).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});

// jsdom has no layout; fake a scroller's metrics.
function fakeScroller(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    // Browsers clamp assignments into range; so does the fake.
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
  return el;
}

describe("settleScroller", () => {
  it("pulls an offset left past the maximum back into range, via a one-pixel nudge", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    // Keyboard closed: the box grew from 285 to 621, the offset stayed at the
    // old maximum (2000 - 285 = 1715), which is 336px past the new one.
    const el = fakeScroller(1715, 2000, 621);
    settleScroller(el, false);
    expect(el.scrollTop).toBe(1378);
    frames.forEach((f) => f(0));
    expect(el.scrollTop).toBe(1379);
    vi.unstubAllGlobals();
  });

  it("sticks to the end when asked, and leaves layout-less elements alone", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const el = fakeScroller(100, 2000, 621);
    settleScroller(el, true);
    expect(el.scrollTop).toBe(1378);
    frames.forEach((f) => f(0));
    expect(el.scrollTop).toBe(1379);
    expect(isAtBottom(el)).toBe(true);

    const none = fakeScroller(50, 0, 0);
    settleScroller(none, true);
    expect(none.scrollTop).toBe(50);
    vi.unstubAllGlobals();
  });
});
