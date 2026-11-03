import { describe, it, expect } from "vitest";
import { ClaudeSession } from "../../src/session/claude";
describe("Claude executable override", () => {
  it("passes the configured launcher to the Agent SDK", () => {
    const previous = process.env.AGENT_TEAM_CLAUDE_EXECUTABLE;
    process.env.AGENT_TEAM_CLAUDE_EXECUTABLE = "/tmp/claude-locked";
    try {
      const session = new ClaudeSession({ cwd: "/tmp" });
      const options = (
        session as unknown as { buildOptions(): { pathToClaudeCodeExecutable?: string } }
      ).buildOptions();
      expect(options.pathToClaudeCodeExecutable).toBe("/tmp/claude-locked");
    } finally {
      if (previous === undefined) delete process.env.AGENT_TEAM_CLAUDE_EXECUTABLE;
      else process.env.AGENT_TEAM_CLAUDE_EXECUTABLE = previous;
    }
  });
});
