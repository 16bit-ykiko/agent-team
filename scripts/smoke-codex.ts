// Prove a Codex model slug works through the binary the server resolves
// (`which codex` first, like service/src/codex-session.ts).
// Usage: npm run smoke:codex -- <slug> [effort]
import { execSync } from "node:child_process";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";

const [slug, effort] = process.argv.slice(2);
if (!slug) {
  console.error("usage: npm run smoke:codex -- <slug> [effort]");
  process.exit(2);
}

const bin = execSync("which codex", { encoding: "utf-8" }).trim();
console.log(`binary: ${bin} (${execSync(`${bin} --version`, { encoding: "utf-8" }).trim()})`);

const codex = new Codex({ codexPathOverride: bin });
const thread = codex.startThread({
  workingDirectory: "/tmp",
  sandboxMode: "read-only",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  model: slug,
  ...(effort && { modelReasoningEffort: effort as ThreadOptions["modelReasoningEffort"] }),
});
const turn = await thread.run("Reply with the single word PONG.");
console.log(`result: ${turn.finalResponse.trim()}`);
