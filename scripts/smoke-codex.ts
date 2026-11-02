// Prove a Codex model slug works through the session the server runs: the
// pinned @openai/codex binary's app-server, one turn.
// Usage: npm run smoke:codex -- <slug> [effort]
import { execFileSync } from "node:child_process";
import type { StreamEvent } from "../service/src/session/claude.ts";
import { CodexSession } from "../service/src/session/codex.ts";
import { codexBinary } from "../service/src/session/codex-rpc.ts";

const [slug, effort] = process.argv.slice(2);
if (!slug) {
  console.error("usage: npm run smoke:codex -- <slug> [effort]");
  process.exit(2);
}

const bin = codexBinary();
console.log(`binary: ${bin} (${execFileSync(bin, ["--version"], { encoding: "utf-8" }).trim()})`);

const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: slug, effort });
let text = "";
session.on("event", (e: StreamEvent) => {
  if (e.kind === "text_delta") text += e.content;
  if (e.kind === "result" || e.kind === "error") {
    console.log(e.kind === "result" ? `result: ${text.trim()}` : `error: ${e.content}`);
    session.abort();
    process.exit(e.kind === "result" ? 0 : 1);
  }
});
await session.send("Reply with the single word PONG.");
