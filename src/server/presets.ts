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
];

export const MODEL_OPTIONS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];
