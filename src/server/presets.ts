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
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", backend: "claude", effort: "xhigh" },
  { id: "claude-opus-4-6[1m]", label: "Claude Opus 4.6 (1M)", backend: "claude", effort: "xhigh" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", backend: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", backend: "claude" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", backend: "claude" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", backend: "claude", effort: "xhigh" },
  { id: "claude-fable-5", label: "Claude Fable 5", backend: "claude" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", backend: "claude" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", backend: "claude" },
  { id: "gpt-5.5", label: "GPT-5.5", backend: "codex" },
];
