import { describe, it, expect } from "vitest";
import {
  formatSize,
  formatDuration,
  formatRelative,
  formatResetTime,
  formatTokens,
  shortModel,
} from "../src/format";

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
    expect(shortModel("claude-opus-5-5[1m]")).toBe("opus 5.5 [1m]");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("gpt-5.6-sol")).toBe("gpt 5.6 sol");
    expect(shortModel("deepseek-v4-pro")).toBe("deepseek v4 pro");
  });
});

describe("formatTokens", () => {
  it("abbreviates token counts", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(84_000)).toBe("84k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

describe("formatDuration", () => {
  it("keeps a tenth of a second under a minute, then whole units", () => {
    expect(formatDuration(4_200)).toBe("4.2s");
    expect(formatDuration(13_700)).toBe("13.7s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(65_400)).toBe("1m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    // Rounds before picking the unit.
    expect(formatDuration(59_960)).toBe("1m 0s");
  });
});

describe("formatSize", () => {
  it("reads as bytes, KB or MB", () => {
    expect([formatSize(812), formatSize(2048), formatSize(3.4 * 1024 * 1024)]).toEqual([
      "812 B",
      "2.0 KB",
      "3.4 MB",
    ]);
  });
});
