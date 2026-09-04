import { describe, it, expect } from "vitest";
import { ViewportTracker, healViewport } from "../src/viewportHeal";

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
