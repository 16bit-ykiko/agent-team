import { describe, it, expect } from "vitest";
import { formatRelative, formatResetTime, shortModel } from "../src/format";

const NOW = 1_800_000_000_000;

describe("formatRelative", () => {
  it("rounds to the coarsest sensible unit", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 16 * 86_400_000, NOW)).toBe("16d ago");
    expect(formatRelative(NOW - 70 * 86_400_000, NOW)).toBe("2mo ago");
    expect(formatRelative(NOW - 400 * 86_400_000, NOW)).toBe("1y ago");
    expect(formatRelative(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("formatResetTime", () => {
  it("formats the remaining time until a unix-seconds reset", () => {
    expect(formatResetTime(NOW / 1000 - 1, NOW)).toBe("now");
    expect(formatResetTime(NOW / 1000 + 30 * 60, NOW)).toBe("30m");
    expect(formatResetTime(NOW / 1000 + 90 * 60, NOW)).toBe("1h30m");
    expect(formatResetTime(NOW / 1000 + 120 * 60, NOW)).toBe("2h");
  });
});

describe("shortModel", () => {
  it("turns model ids into short human labels", () => {
    expect(shortModel("claude-fable-5-1[1m]")).toBe("fable 5.1 [1m]");
    expect(shortModel("claude-fable-5-1")).toBe("fable 5.1");
    expect(shortModel("claude-fable-5")).toBe("fable 5");
    expect(shortModel("claude-opus-4-6")).toBe("opus 4.6");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("gpt-5.6-sol")).toBe("gpt 5.6 sol");
    expect(shortModel("deepseek-v4-pro")).toBe("deepseek v4 pro");
  });
});
