import { describe, it, expect } from "vitest";
import { viewportVars, fullHeight, keyboardOpen, readSafeTop } from "../src/viewport";

// A healthy phone in the browser: the layout viewport is the whole story.
const browser = {
  vvHeight: 844,
  vvOffsetTop: 0,
  innerHeight: 844,
  screenHeight: 844,
  safeTop: 0,
  standalone: false,
};

// The reported bug, straight from a device snapshot: iPhone 16 Pro home-screen
// app whose layout viewport stayed 62px short of the 874px screen.
const shrunk = {
  vvHeight: 812,
  vvOffsetTop: 0,
  innerHeight: 812,
  screenHeight: 874,
  safeTop: 62,
  standalone: true,
};

describe("viewportVars", () => {
  it("leaves the CSS default alone when no keyboard is up", () => {
    expect(viewportVars(browser)).toEqual({ height: null, offset: null });
  });

  it("pins the app to the visible strip while the keyboard is open", () => {
    expect(viewportVars({ ...browser, vvHeight: 500, vvOffsetTop: 20 })).toEqual({
      height: "500px",
      offset: "20px",
    });
  });

  it("stretches a shrunk standalone viewport back to the screen height", () => {
    expect(viewportVars(shrunk)).toEqual({ height: "874px", offset: null });
  });

  it("prefers the keyboard strip over the screen height while typing", () => {
    expect(viewportVars({ ...shrunk, vvHeight: 420, vvOffsetTop: 12 })).toEqual({
      height: "420px",
      offset: "12px",
    });
  });
});

describe("keyboardOpen", () => {
  it("does not mistake the standalone shortfall for a keyboard", () => {
    expect(keyboardOpen({ ...browser, vvHeight: 810 })).toBe(false);
    expect(keyboardOpen({ ...browser, vvHeight: 500 })).toBe(true);
  });
});

describe("fullHeight", () => {
  it("recovers the screen height only for a short standalone viewport", () => {
    expect(fullHeight(shrunk)).toBe(874);
    expect(fullHeight(browser)).toBe(null);
    // Healthy standalone app: nothing to recover.
    expect(fullHeight({ ...shrunk, innerHeight: 874 })).toBe(null);
  });

  it("stays out of situations it cannot explain", () => {
    // In a browser tab the short viewport is real (toolbars), not a bug.
    expect(fullHeight({ ...shrunk, standalone: false })).toBe(null);
    // No top inset means the web view does not own the full screen.
    expect(fullHeight({ ...shrunk, safeTop: 0 })).toBe(null);
    // Landscape, where screen.height may still report the portrait value.
    expect(fullHeight({ ...shrunk, innerHeight: 402 })).toBe(null);
  });
});

describe("readSafeTop", () => {
  it("returns 0 where env() safe areas are unsupported, without leaking a probe", () => {
    expect(readSafeTop()).toBe(0);
    expect(document.body.children.length).toBe(0);
  });
});
