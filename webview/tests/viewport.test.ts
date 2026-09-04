import { describe, it, expect } from "vitest";
import { viewportVars } from "../src/viewport";

describe("viewportVars", () => {
  it("leaves the CSS default alone when no keyboard is up", () => {
    expect(viewportVars(844, 0, 844)).toEqual({ height: null, offset: null });
    // Standalone iOS can report a slightly shorter visual viewport; that is
    // not a keyboard.
    expect(viewportVars(810, 0, 844)).toEqual({ height: null, offset: null });
  });

  it("pins the app to the visible strip while the keyboard is open", () => {
    expect(viewportVars(500, 20, 844)).toEqual({ height: "500px", offset: "20px" });
  });
});
