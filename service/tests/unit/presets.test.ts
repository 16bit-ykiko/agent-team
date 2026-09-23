import { describe, it, expect } from "vitest";
import {
  MODEL_OPTIONS,
  backendForModel,
  codexContextWindow,
  codexFastTier,
  codexModelId,
  defaultEffortForModel,
  effortLevelsForModel,
  supportsAdaptiveThinking,
  supportsFastMode,
} from "../../src/presets";

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

  it("offers Opus 5.5 in both windows with the five-level effort set", () => {
    for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]"]) {
      expect(MODEL_OPTIONS.some((m) => m.id === id)).toBe(true);
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
