import { describe, it, expect } from "vitest";
import { isImeKeyEvent } from "../src/ime";

const ev = (over: { key?: string; timeStamp?: number; isComposing?: boolean } = {}) => ({
  key: over.key ?? "Enter",
  timeStamp: over.timeStamp ?? 1000,
  nativeEvent: { isComposing: over.isComposing ?? false },
});

describe("isImeKeyEvent", () => {
  it("lets a plain Enter through", () => {
    expect(isImeKeyEvent(ev(), false, 0)).toBe(false);
  });

  it("swallows Enter while composing (Chrome: isComposing on the event)", () => {
    expect(isImeKeyEvent(ev({ isComposing: true }), false, 0)).toBe(true);
  });

  it("swallows keys while the composition flag is set", () => {
    expect(isImeKeyEvent(ev({ key: "a" }), true, 0)).toBe(true);
  });

  it("swallows the Enter that lands right after compositionend (Safari ordering)", () => {
    // Safari fires compositionend before the confirming Enter's keydown,
    // so isComposing is already false — only the timestamp distinguishes it.
    expect(isImeKeyEvent(ev({ timeStamp: 1002 }), false, 1000)).toBe(true);
  });

  it("lets a deliberate Enter through once the composition is long finished", () => {
    expect(isImeKeyEvent(ev({ timeStamp: 2000 }), false, 1000)).toBe(false);
  });

  it("does not swallow non-Enter keys after compositionend", () => {
    expect(isImeKeyEvent(ev({ key: "a", timeStamp: 1002 }), false, 1000)).toBe(false);
  });
});
