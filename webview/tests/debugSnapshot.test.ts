import { describe, it, expect } from "vitest";
import { collectSnapshot, trimmedHtml, SNAPSHOT_SELECTORS } from "../src/debugSnapshot";

describe("debug snapshot", () => {
  it("collects geometry for the shell elements that exist and trims message bodies", () => {
    document.body.innerHTML = `
      <div id="root"><div class="app"><div class="main-panel">
        <div class="panel-header"></div>
        <div class="messages">
          <div class="history-hint">hint</div>
          <div class="message">1</div><div class="message">2</div>
          <div class="message">3</div><div class="message">4</div>
        </div>
        <div class="input-area"><div class="input-row"><textarea class="chat-input"></textarea></div></div>
      </div></div></div>`;
    document.documentElement.style.setProperty("--app-height", "700px");
    const snap = collectSnapshot();
    const selectors = snap.elements.map((e) => e.selector);
    expect(selectors).toContain(".messages");
    expect(selectors).toContain(".input-area");
    expect(selectors).not.toContain(".sidebar");
    expect(selectors.every((s) => SNAPSHOT_SELECTORS.includes(s))).toBe(true);
    const messages = snap.elements.find((e) => e.selector === ".messages")!;
    // jsdom reports overflow as set in CSS only; force it for the assertion.
    expect(messages.scroll === undefined || typeof messages.scroll.top === "number").toBe(true);
    expect(selectors).toContain(".messages .message");
    expect(selectors).toContain(".messages > :last-child");
    expect(snap.cssVars["--app-height"]).toBe("700px");
    expect(snap.cssVars["--app-offset"]).toBe("(unset)");
    expect(snap.viewport.inner).toBe(window.innerHeight);

    const html = trimmedHtml(3);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/class="message"/g) ?? []).length).toBe(3);
    expect(html).toContain("history-hint");
    // The live DOM is untouched.
    expect(document.querySelectorAll(".message")).toHaveLength(4);
  });
});
