// Prove a Claude model id works through the SDK binary the server actually
// spawns (node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude), not
// the system CLI. Usage: npm run smoke:claude -- <model> [effort]
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const [model, effort] = process.argv.slice(2);
if (!model) {
  console.error("usage: npm run smoke:claude -- <model> [effort]");
  process.exit(2);
}

const q = query({
  prompt: "Reply with the single word PONG.",
  options: {
    model,
    ...(effort && { effort: effort as "low" | "medium" | "high" | "max" }),
    cwd: "/tmp",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: [],
  },
});

for await (const msg of q as AsyncIterable<SDKMessage>) {
  if (msg.type === "system" && msg.subtype === "init")
    console.log(`init: model=${msg.model} effort=${String(msg.effort ?? "-")}`);
  if (msg.type === "result") {
    console.log(`result: ${msg.subtype}` + ("result" in msg ? ` ${msg.result.trim()}` : ""));
    process.exit(msg.subtype === "success" ? 0 : 1);
  }
}
