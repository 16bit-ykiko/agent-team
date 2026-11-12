// A new agent: its model, and the reasoning effort the model takes.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AddAgentDialog } from "../src/workspace/dialogs";
import type { ModelOption } from "../src/state/useServer";

const models: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    backend: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "cursor/gemini-4-argon",
    label: "Gemini 4 Argon",
    backend: "cursor",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  { id: "cursor/composer-2.5", label: "Composer", backend: "cursor", effortLevels: [] },
  {
    id: "agy/gemini-4-carbon",
    label: "Gemini 4 Carbon",
    backend: "agy",
    effortLevels: ["low", "medium", "high"],
    effort: "high",
    defaultEffort: "medium",
  },
];

const dialog = () => {
  const onAdd = vi.fn();
  const utils = render(
    <AddAgentDialog
      presets={[{ name: "Kisara", avatar: "k.jpg", color: "#D8A0D8" }]}
      models={models}
      accounts={[]}
      onClose={() => {}}
      onAdd={onAdd}
    />,
  );
  const model = () => utils.getByText("Model").parentElement!.querySelector("select")!;
  const effort = () => utils.queryByLabelText("Reasoning effort") as HTMLSelectElement | null;
  const levels = () => [...effort()!.options].map((o) => o.textContent);
  return { ...utils, onAdd, model, effort, levels };
};

describe("adding an agent", () => {
  it("offers the effort levels of the model chosen, its default first", () => {
    const d = dialog();
    expect(d.levels()).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    fireEvent.change(d.model(), { target: { value: "cursor/gemini-4-argon" } });
    expect(d.levels()).toEqual(["default (medium)", "low", "medium", "high"]);
    fireEvent.change(d.model(), { target: { value: "cursor/composer-2.5" } });
    expect(d.effort()).toBeNull();
  });

  it("adds it at the effort chosen, kept across models that have it", () => {
    const d = dialog();
    fireEvent.change(d.effort()!, { target: { value: "high" } });
    fireEvent.change(d.model(), { target: { value: "cursor/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("high");
    fireEvent.change(d.model(), { target: { value: "claude-opus-5-5" } });
    fireEvent.change(d.effort()!, { target: { value: "max" } });
    // Gemini has no max: back to its default.
    fireEvent.change(d.model(), { target: { value: "cursor/gemini-4-argon" } });
    expect(d.effort()!.value).toBe("");
    fireEvent.change(d.effort()!, { target: { value: "low" } });
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd).toHaveBeenCalledWith(
      "Kisara",
      "cursor/gemini-4-argon",
      "k.jpg",
      "#D8A0D8",
      undefined,
      "low",
    );
  });

  it("groups the models by backend, agy's under Antigravity", () => {
    const d = dialog();
    const groups = [...d.model().querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => o.value),
    ]);
    expect(groups).toEqual([
      ["Claude", ["claude-opus-5-5"]],
      ["Cursor", ["cursor/gemini-4-argon", "cursor/composer-2.5"]],
      ["Antigravity", ["agy/gemini-4-carbon"]],
    ]);
    fireEvent.change(d.model(), { target: { value: "agy/gemini-4-carbon" } });
    expect(d.levels()).toEqual(["default (high)", "low", "medium", "high"]);
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd.mock.calls[0][1]).toBe("agy/gemini-4-carbon");
  });

  it("leaves the effort to the model when none is chosen", () => {
    const d = dialog();
    fireEvent.click(d.getByText("Add"));
    expect(d.onAdd.mock.calls[0][5]).toBeUndefined();
  });
});
