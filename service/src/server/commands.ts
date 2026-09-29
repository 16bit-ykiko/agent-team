import type { CommandInfo } from "../session/claude";

// Commands handled by this server (Workspace.tryHandleCommand) rather than
// forwarded to the agent. Merged into the SDK command list for autocomplete.
const LOCAL_COMMANDS: CommandInfo[] = [
  {
    name: "effort",
    description: "Show or set the model reasoning effort level",
    argumentHint: "[low|medium|high|xhigh|max|ultra]",
  },
  {
    name: "fast",
    description: "Toggle fast mode (quicker responses, higher usage)",
    argumentHint: "[on|off]",
  },
  {
    name: "goal",
    description: "Set, show, or clear a Codex goal the agent keeps working toward",
    argumentHint: "[objective|show|clear]",
  },
  { name: "context", description: "Show context window usage", argumentHint: "" },
  { name: "usage", description: "Show session token usage and cost", argumentHint: "" },
];

export function mergeLocalCommands(commands: CommandInfo[]): CommandInfo[] {
  const names = new Set(commands.map((c) => c.name));
  return [...LOCAL_COMMANDS.filter((c) => !names.has(c.name)), ...commands];
}
