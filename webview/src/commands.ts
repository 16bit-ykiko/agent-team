import type { AgentInfo } from "./useServer";

export interface CommandDef {
  name: string;
  icon: string;
  description: string;
  placeholder?: string;
  buildMessage: (args: string, ctx: CommandContext) => CommandResult;
}

export interface CommandContext {
  project: string;
  cwd: string;
  agents: AgentInfo[];
}

export interface CommandResult {
  content: string;
  target?: string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "pr",
    icon: "🚀",
    description: "Format, commit, push, and open a PR",
    placeholder: "optional PR title or target repo",
    buildMessage: (args) => ({
      content: `Format the code (check pixi.toml, package.json, Makefile for the format command), then commit all changes with a descriptive message, push to remote, and open a PR.${args ? ` PR context: ${args}` : ""} Do NOT force push. If the branch doesn't have an upstream, push with -u.`,
    }),
  },
  {
    name: "commit",
    icon: "💾",
    description: "Format code and commit changes",
    placeholder: "optional commit message hint",
    buildMessage: (args) => ({
      content: `Format the code first (check pixi.toml, package.json, Makefile for the format command), then commit all current changes.${args ? ` Commit context: ${args}` : " Write a concise, descriptive commit message based on the actual changes."}`,
    }),
  },
  {
    name: "review",
    icon: "🔍",
    description: "Review code changes on current branch",
    placeholder: "optional focus area",
    buildMessage: (args, ctx) => {
      const reviewer = ctx.agents.find((a) => a.name.toLowerCase().includes("review"));
      return {
        content: `Review the code changes on the current branch (git diff against base). Check for: bugs, logic errors, code quality issues, missing error handling, and potential improvements.${args ? ` Focus on: ${args}` : ""} Be specific and actionable in your feedback.`,
        target: reviewer?.name,
      };
    },
  },
  {
    name: "plan",
    icon: "📋",
    description: "Write a detailed implementation plan",
    placeholder: "what to plan",
    buildMessage: (args) => ({
      content: `Write a detailed implementation plan for: ${args || "the task we just discussed"}. Structure it with: 1) Current state analysis, 2) Proposed changes (specific files and what to modify), 3) Implementation phases/order, 4) Potential risks or edge cases. Be concrete — reference actual file paths and function names.`,
    }),
  },
  {
    name: "assign",
    icon: "📨",
    description: "Assign a task to a specific agent",
    placeholder: "AgentName task description",
    buildMessage: (args, ctx) => {
      const parts = args.match(/^(\S+)\s+([\s\S]+)/);
      if (!parts) return { content: args || "What should I do?" };
      const targetName = parts[1];
      const task = parts[2];
      const agent = ctx.agents.find((a) => a.name.toLowerCase() === targetName.toLowerCase());
      if (agent) {
        return { content: task, target: agent.name };
      }
      return { content: `@${targetName} ${task}` };
    },
  },
  {
    name: "diff",
    icon: "📊",
    description: "Show branch changes summary",
    placeholder: "optional base branch",
    buildMessage: (args) => ({
      content: `Show a summary of all changes on the current branch vs ${args || "the base branch (main/master)"}. Include: 1) Files changed with net line additions/deletions, 2) A brief description of what each changed file does, 3) Total stats. Use git diff --stat and git diff for the details.`,
    }),
  },
  {
    name: "test",
    icon: "🧪",
    description: "Run the project's test suite",
    placeholder: "optional test filter",
    buildMessage: (args) => ({
      content: `Run the project's test suite${args ? ` (filter: ${args})` : ""}. Check pixi.toml, package.json, Makefile, or CMakeLists.txt for the test command. Report pass/fail results clearly. If tests fail, analyze the failure and suggest fixes.`,
    }),
  },
  {
    name: "format",
    icon: "✨",
    description: "Run code formatter",
    buildMessage: () => ({
      content: `Run the project's code formatter. Check pixi.toml, package.json, Makefile for the format command (e.g. pixi run format, npm run format, make format). Report what was changed.`,
    }),
  },
];
