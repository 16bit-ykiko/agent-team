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
  // Input context window in tokens, when it differs from the backend default
  // (codex reads it from `model_context_window`; Claude encodes it in the id).
  contextWindow?: number;
  // Codex: the `service_tier` that the model metadata lists as its Fast mode.
  fastTier?: string;
  // Effort the backend runs at when none is set explicitly (codex model
  // metadata `default_reasoning_level`); shown so the status row is never blank.
  defaultEffort?: string;
}

// xhigh was introduced with Opus 4.7; older models support the 4 base levels.
const EFFORT_FOUR = ["low", "medium", "high", "max"];
const EFFORT_FIVE = ["low", "medium", "high", "xhigh", "max"];
// Codex effort sets, from the server model metadata (~/.codex/models_cache.json).
// "ultra" (max reasoning + automatic task delegation) is Sol/Terra only.
const CODEX_EFFORT = ["low", "medium", "high", "xhigh"];
const CODEX_EFFORT_MAX = [...CODEX_EFFORT, "max"];
const CODEX_EFFORT_ULTRA = [...CODEX_EFFORT_MAX, "ultra"];
// Codex context windows (~/.codex/models_cache.json): the default 272K, and
// the 872K "max" window the 1M-class models accept (1M minus output reserve).
const CODEX_CONTEXT = 272_000;
const CODEX_CONTEXT_1M = 872_000;
// Every ChatGPT codex model lists Fast as service tier "priority".
const CODEX_FAST = "priority";

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
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-6-astra[1m]",
    label: "GPT-6 Astra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    backend: "codex",
    defaultEffort: "low",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-sol[1m]",
    label: "GPT-5.6 Sol (1M)",
    backend: "codex",
    defaultEffort: "low",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-terra[1m]",
    label: "GPT-5.6 Terra (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_ULTRA,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
  {
    id: "gpt-5.6-luna[1m]",
    label: "GPT-5.6 Luna (1M)",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT_MAX,
    contextWindow: CODEX_CONTEXT_1M,
    fastTier: CODEX_FAST,
  },
  // gpt-5.5 tops out at the default window.
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    backend: "codex",
    defaultEffort: "medium",
    effortLevels: CODEX_EFFORT,
    contextWindow: CODEX_CONTEXT,
    fastTier: CODEX_FAST,
  },
];

function findModelOption(modelId: string): ModelOption | undefined {
  return (
    MODEL_OPTIONS.find((m) => m.id === modelId) ??
    MODEL_OPTIONS.find((m) => m.id === modelId.replace(/\[1m\]$/, ""))
  );
}

export function backendForModel(modelId: string): "claude" | "codex" {
  return findModelOption(modelId)?.backend ?? (modelId.startsWith("gpt-") ? "codex" : "claude");
}

// The id the backend CLI understands: codex has no `[1m]` suffix convention,
// the window is a config value instead (see codexContextWindow).
export function codexModelId(modelId: string): string {
  return modelId.replace(/\[1m\]$/, "");
}

// Context window to configure for a codex model, or null for the CLI default.
export function codexContextWindow(modelId: string): number | null {
  const opt = findModelOption(modelId);
  if (opt?.backend !== "codex" || !opt.contextWindow) return null;
  // Only the 1M variants need an override; the plain ids use the CLI default.
  return /\[1m\]$/.test(modelId) ? opt.contextWindow : null;
}

// Fast mode: Claude runs it via the SDK's fastMode option (models that lack
// it report a disabled reason at init); codex needs a service tier.
export function supportsFastMode(modelId: string): boolean {
  const opt = findModelOption(modelId);
  if (!opt) return false;
  return opt.backend === "claude" ? opt.id.startsWith("claude-") : Boolean(opt.fastTier);
}

export function codexFastTier(modelId: string): string | null {
  return findModelOption(modelId)?.fastTier ?? null;
}

// Effort a fresh agent on this model runs at: the preset's initial level,
// else the backend default when we know it.
export function defaultEffortForModel(modelId: string): string | null {
  const opt = findModelOption(modelId);
  return opt?.effort ?? opt?.defaultEffort ?? null;
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
