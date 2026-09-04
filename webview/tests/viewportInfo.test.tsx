import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { formatViewportFacts, readViewportFacts, ViewportInfo } from "../src/ViewportInfo";

describe("viewport diagnostics", () => {
  it("formats the facts compactly", () => {
    expect(
      formatViewportFacts({
        inner: 793,
        outer: 852,
        screen: 852,
        vv: 793,
        vvTop: 0,
        dvh: 793,
        safeTop: 59,
        safeBottom: 34,
        standalone: true,
      }),
    ).toBe("inner 793 · outer 852 · screen 852 · vv 793 · dvh 793 · safe 59/34 · standalone");
  });

  it("reads facts from the window without leaving a probe behind", () => {
    const before = document.body.childElementCount;
    const f = readViewportFacts();
    expect(document.body.childElementCount).toBe(before);
    expect(f.inner).toBe(window.innerHeight);
    expect(typeof f.standalone).toBe("boolean");
    const { container } = render(<ViewportInfo />);
    expect(container.querySelector(".viewport-info")!.textContent).toContain("inner");
  });
});
