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
// Codex effort sets, from the server model metadata (~/.codex/models_cache.json).
// "ultra" (max reasoning + automatic task delegation) is Sol/Terra only.
const CODEX_EFFORT = ["low", "medium", "high", "xhigh"];
const CODEX_EFFORT_MAX = [...CODEX_EFFORT, "max"];
const CODEX_EFFORT_ULTRA = [...CODEX_EFFORT_MAX, "ultra"];

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
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    backend: "claude",
    effort: "xhigh",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-opus-5[1m]",
    label: "Claude Opus 5 (1M)",
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
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-fable-5-1[1m]",
    label: "Claude Fable 5.1 (1M)",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", backend: "claude" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", backend: "claude" },
  // Codex models available on ChatGPT accounts. Bare gpt-5.6 / gpt-5.6-pro are
  // API-key only and rejected with a ChatGPT login, so they are not listed.
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    backend: "codex",
    effortLevels: CODEX_EFFORT_ULTRA,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    backend: "codex",
    effortLevels: CODEX_EFFORT_ULTRA,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    backend: "codex",
    effortLevels: CODEX_EFFORT_ULTRA,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    backend: "codex",
    effortLevels: CODEX_EFFORT_MAX,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    backend: "codex",
    effortLevels: CODEX_EFFORT,
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
