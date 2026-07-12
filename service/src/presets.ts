export interface AgentPreset {
  name: string;
  avatar: string;
  color: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  { name: "Kisara", avatar: "avatars/Kisara.jpg", color: "#D8A0D8" },
  { name: "Isla", avatar: "avatars/Isla.jpg", color: "#C0C0C0" },
  { name: "Alice", avatar: "avatars/Alice.jpg", color: "#F0D264" },
];

export interface ModelOption {
  id: string;
  label: string;
  backend: "claude" | "codex";
  effort?: string;
  // Effort levels the model actually supports. Empty array = no effort support.
  // Omitted = unknown model, fall back to the full canonical set.
  effortLevels?: string[];
}

// xhigh was introduced with Opus 4.7; older models support the 4 base levels.
const EFFORT_FOUR = ["low", "medium", "high", "max"];
const EFFORT_FIVE = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    backend: "claude",
    effort: "high",
    effortLevels: EFFORT_FOUR,
  },
  {
    id: "claude-opus-4-6[1m]",
    label: "Claude Opus 4.6 (1M)",
    backend: "claude",
    effort: "high",
    effortLevels: EFFORT_FOUR,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    backend: "claude",
    effortLevels: EFFORT_FOUR,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    backend: "claude",
    effortLevels: [],
  },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", backend: "claude", effortLevels: EFFORT_FIVE },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    backend: "claude",
    effort: "xhigh",
    effortLevels: EFFORT_FIVE,
  },
  { id: "claude-fable-5", label: "Claude Fable 5", backend: "claude", effortLevels: EFFORT_FIVE },
  {
    id: "claude-fable-5[1m]",
    label: "Claude Fable 5 (1M)",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", backend: "claude" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", backend: "claude" },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    backend: "codex",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
  },
];

function findModelOption(modelId: string): ModelOption | undefined {
  return (
    MODEL_OPTIONS.find((m) => m.id === modelId) ??
    MODEL_OPTIONS.find((m) => m.id === modelId.replace(/\[1m\]$/, ""))
  );
}

export function effortLevelsForModel(modelId: string): string[] {
  return findModelOption(modelId)?.effortLevels ?? EFFORT_FIVE;
}

// Adaptive thinking (with a display option) is a Claude 4.6+ feature; codex
// models carry effort levels too, so gate on backend as well.
export function supportsAdaptiveThinking(modelId: string): boolean {
  const opt = findModelOption(modelId);
  return opt?.backend === "claude" && (opt.effortLevels?.length ?? 0) > 0;
}
