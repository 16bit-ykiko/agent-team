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

export type Backend = "claude" | "codex" | "cursor";

export interface ModelOption {
  id: string;
  label: string;
  backend: Backend;
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
  // Cursor: the model parameter effort is sent as (its name varies by model)
  // and whether the model has a `fast` parameter. A parameter left out runs
  // at its first allowed value, not the catalog's default variant.
  cursorParams?: { effort?: string; fast?: boolean };
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
// Cursor models are `cursor/` + the SDK's id (Cursor.models.list()), which
// alone can collide with ours (it lists claude-opus-5-5 and gpt-5.5 too).
const CURSOR_PREFIX = "cursor/";

// The picker's list. Models dropped from it move to LEGACY_MODELS, so agents
// still on one keep their settings until switched with /model. Opus 5.5,
// Fable 5.1 and Fable 5 come only with the 1M window: the plain id already
// has it (the CLI reports 1,000,000), so there is no "[1m]" entry.
export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    backend: "claude",
    effort: "xhigh",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-opus-5[1m]",
    label: "Claude Opus 5",
    backend: "claude",
    effort: "xhigh",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-opus-4-8[1m]",
    label: "Claude Opus 4.8",
    backend: "claude",
    effort: "xhigh",
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
  // Cursor's own models; efforts and defaults from its catalog
  // (Cursor.models.list(), the default variant's parameters).
  {
    id: "cursor/composer-2.5",
    label: "Composer 2.5",
    backend: "cursor",
    effortLevels: [],
    cursorParams: { fast: true },
  },
  {
    id: "cursor/grok-4.7",
    label: "Grok 4.7",
    backend: "cursor",
    defaultEffort: "high",
    effortLevels: ["low", "medium", "high", "xhigh"],
    cursorParams: { effort: "reasoning_effort", fast: true },
  },
  {
    id: "cursor/gemini-4-argon",
    label: "Gemini 4 Argon",
    backend: "cursor",
    defaultEffort: "medium",
    effortLevels: ["low", "medium", "high"],
    cursorParams: { effort: "reasoning_effort" },
  },
  {
    id: "cursor/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    backend: "cursor",
    defaultEffort: "high",
    effortLevels: ["low", "medium", "high"],
    cursorParams: { effort: "reasoning_effort" },
  },
  {
    id: "cursor/kimi-k3",
    label: "Kimi K3",
    backend: "cursor",
    defaultEffort: "max",
    effortLevels: ["low", "high", "max"],
    cursorParams: { effort: "reasoning" },
  },
  {
    id: "cursor/glm-5p3",
    label: "GLM 5.3",
    backend: "cursor",
    defaultEffort: "max",
    effortLevels: ["low", "high", "max"],
    cursorParams: { effort: "reasoning" },
  },
  {
    id: "cursor/deepseek-v41-flash-1017",
    label: "DeepSeek V4.1 Flash",
    backend: "cursor",
    defaultEffort: "max",
    effortLevels: ["none", "low", "medium", "high", "max"],
    cursorParams: { effort: "reasoning_effort" },
  },
];

export const LEGACY_MODELS: ModelOption[] = [
  // The same models as the plain ids; agents created with the suffix keep it.
  {
    id: "claude-opus-5-5[1m]",
    label: "Claude Opus 5.5",
    backend: "claude",
    effort: "xhigh",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-fable-5-1[1m]",
    label: "Claude Fable 5.1",
    backend: "claude",
    effortLevels: EFFORT_FIVE,
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
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
];

export function findModelOption(modelId: string): ModelOption | undefined {
  const base = modelId.replace(/\[1m\]$/, "");
  for (const list of [MODEL_OPTIONS, LEGACY_MODELS]) {
    const hit = list.find((m) => m.id === modelId) ?? list.find((m) => m.id === base);
    if (hit) return hit;
  }
  return undefined;
}

// An id in neither list is a Claude model newer than both (tried with /model
// before it is added): it gets what current Claude models have.
function isNewClaude(modelId: string): boolean {
  return !findModelOption(modelId) && modelId.startsWith("claude-");
}

export function backendForModel(modelId: string): Backend {
  const known = findModelOption(modelId)?.backend;
  if (known) return known;
  if (modelId.startsWith(CURSOR_PREFIX)) return "cursor";
  return modelId.startsWith("gpt-") ? "codex" : "claude";
}

// The model as the Cursor SDK takes it: its own id, effort and fast mode as
// the model's parameters.
export function cursorModel(
  modelId: string,
  effort: string | undefined,
  fast: boolean | undefined,
): { id: string; params?: Array<{ id: string; value: string }> } {
  const id = modelId.startsWith(CURSOR_PREFIX) ? modelId.slice(CURSOR_PREFIX.length) : modelId;
  const opt = findModelOption(modelId);
  const params: Array<{ id: string; value: string }> = [];
  const level = effort ?? opt?.defaultEffort;
  if (opt?.cursorParams?.effort && level)
    params.push({ id: opt.cursorParams.effort, value: level });
  if (opt?.cursorParams?.fast) params.push({ id: "fast", value: fast ? "true" : "false" });
  return params.length ? { id, params } : { id };
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
  if (!opt) return isNewClaude(modelId);
  if (opt.backend === "cursor") return Boolean(opt.cursorParams?.fast);
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
  if (!opt) return isNewClaude(modelId);
  return opt.backend === "claude" && (opt.effortLevels?.length ?? 0) > 0;
}
