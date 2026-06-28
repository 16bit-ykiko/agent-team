export interface AgentPreset {
  name: string;
  avatar: string;
  color: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  { name: "Sakura", avatar: "🌸", color: "#FFB7C5" },
  { name: "Miku", avatar: "🎵", color: "#39C5BB" },
  { name: "Rem", avatar: "💙", color: "#6495ED" },
  { name: "Asuka", avatar: "🔥", color: "#E05A33" },
  { name: "Violet", avatar: "💜", color: "#9B59B6" },
  { name: "Zero Two", avatar: "🌹", color: "#E84057" },
  { name: "Hinata", avatar: "🌻", color: "#C8A2C8" },
  { name: "Emilia", avatar: "❄️", color: "#C0C0C0" },
  { name: "Tohka", avatar: "🌙", color: "#7B68EE" },
  { name: "Rin", avatar: "✨", color: "#E6B422" },
  { name: "Nami", avatar: "🌊", color: "#1E90FF" },
  { name: "Luffy", avatar: "🏴‍☠️", color: "#D32F2F" },
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
