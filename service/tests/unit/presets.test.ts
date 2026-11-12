import { describe, it, expect } from "vitest";
import {
  MODEL_OPTIONS,
  agyModelId,
  backendForModel,
  codexContextWindow,
  codexFastTier,
  codexModelId,
  defaultEffortForModel,
  effortLevelsForModel,
  supportsAdaptiveThinking,
  supportsFastMode,
} from "../../src/config/presets";

describe("codex model presets", () => {
  it("offers a 1M variant for every codex model with the larger window", () => {
    const oneM = MODEL_OPTIONS.filter((m) => m.backend === "codex" && m.id.endsWith("[1m]"));
    expect(oneM.map((m) => m.id)).toEqual([
      "gpt-6-astra[1m]",
      "gpt-5.6-sol[1m]",
      "gpt-5.6-terra[1m]",
      "gpt-5.6-luna[1m]",
    ]);
    for (const m of oneM) {
      expect(m.label).toContain("(1M)");
      expect(MODEL_OPTIONS.some((b) => b.id === codexModelId(m.id))).toBe(true);
    }
  });

  it("maps the 1M suffix to a context window override and a plain CLI model id", () => {
    expect(codexModelId("gpt-6-astra[1m]")).toBe("gpt-6-astra");
    expect(codexModelId("gpt-6-astra")).toBe("gpt-6-astra");
    expect(codexContextWindow("gpt-6-astra[1m]")).toBe(872_000);
    expect(codexContextWindow("gpt-6-astra")).toBeNull();
    expect(codexContextWindow("claude-opus-5[1m]")).toBeNull();
  });

  it("knows which models can run fast and which tier codex needs", () => {
    expect(supportsFastMode("gpt-6-astra[1m]")).toBe(true);
    expect(codexFastTier("gpt-6-astra")).toBe("priority");
    expect(supportsFastMode("claude-opus-5")).toBe(true);
    expect(supportsFastMode("deepseek-v4-pro")).toBe(false);
    expect(supportsFastMode("unknown-model")).toBe(false);
  });

  it("knows Opus 5.5 by either id, with the five-level effort set", () => {
    for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]"]) {
      expect(effortLevelsForModel(id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(defaultEffortForModel(id)).toBe("xhigh");
      expect(supportsFastMode(id)).toBe(true);
      expect(supportsAdaptiveThinking(id)).toBe(true);
      expect(backendForModel(id)).toBe("claude");
    }
  });

  it("resolves the backend from the preset, falling back on the id prefix", () => {
    expect(backendForModel("gpt-5.6-luna[1m]")).toBe("codex");
    expect(backendForModel("gpt-7-unknown")).toBe("codex");
    expect(backendForModel("claude-fable-5-1")).toBe("claude");
  });
});

describe("the model list", () => {
  it("offers only current models, and still knows the ones dropped from it", () => {
    expect(MODEL_OPTIONS.filter((m) => m.backend === "claude").map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-2",
      "claude-fable-5",
      "claude-opus-5[1m]",
      "claude-opus-4-8[1m]",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
    // An agent still on a dropped model keeps its effort levels and thinking.
    expect(effortLevelsForModel("claude-opus-4-6[1m]")).toEqual(["low", "medium", "high", "max"]);
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(effortLevelsForModel("claude-fable-5-1")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(supportsAdaptiveThinking("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("gives no effort levels where none would be sent: DeepSeek, a Cursor model the list lacks", () => {
    expect(effortLevelsForModel("deepseek-v4-pro")).toEqual([]);
    expect(effortLevelsForModel("cursor/claude-opus-5-5")).toEqual([]);
    expect(effortLevelsForModel("cursor/gemini-4-argon")).toEqual(["low", "medium", "high"]);
  });

  it("knows agy's Gemini models by their agy/ prefix, effort as agy's thought level", () => {
    expect(MODEL_OPTIONS.filter((m) => m.backend === "agy").map((m) => m.id)).toEqual([
      "agy/gemini-4-carbon",
      "agy/gemini-4-argon",
      "agy/gemini-4-hydrogen",
      "agy/gemini-3.8-flash",
    ]);
    expect(backendForModel("agy/gemini-4-carbon")).toBe("agy");
    expect(backendForModel("agy/gemini-5")).toBe("agy");
    expect(agyModelId("agy/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(defaultEffortForModel("agy/gemini-4-carbon")).toBe("high");
    expect(defaultEffortForModel("agy/gemini-4-argon")).toBe("medium");
    expect(effortLevelsForModel("agy/gemini-4-hydrogen")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // One the list lacks: which levels it takes, only agy's own list knows.
    expect(effortLevelsForModel("agy/gemini-5")).toEqual([]);
    expect(supportsFastMode("agy/gemini-4-carbon")).toBe(false);
    expect(supportsAdaptiveThinking("agy/gemini-4-carbon")).toBe(false);
  });

  it("treats a Claude id in neither list as a newer Claude model", () => {
    expect(backendForModel("claude-opus-6")).toBe("claude");
    expect(supportsAdaptiveThinking("claude-opus-6")).toBe(true);
    expect(supportsFastMode("claude-opus-6")).toBe(true);
    expect(supportsFastMode("gpt-7")).toBe(false);
  });
});
