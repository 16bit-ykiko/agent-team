import { describe, it, expect } from "vitest";
import { readViewportFacts } from "../src/viewport/facts";

describe("viewport facts", () => {
  it("reads facts from the window without leaving a probe behind", () => {
    const before = document.body.childElementCount;
    const f = readViewportFacts();
    expect(document.body.childElementCount).toBe(before);
    expect(f.inner).toBe(window.innerHeight);
    expect(typeof f.standalone).toBe("boolean");
  });
});
