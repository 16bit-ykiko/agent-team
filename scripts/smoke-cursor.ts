// Prove a Cursor model works through the server's own session
// (service/src/session/cursor.ts), panel tools included: one message, and
// the events it maps to. The key: CURSOR_API_KEY, else ~/.cursor/api_key.txt.
// Usage: npm run smoke:cursor -- <cursor/model> [effort]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { StreamEvent } from "../service/src/session/claude.ts";
import { CursorSession } from "../service/src/session/cursor.ts";

const [model, effort] = process.argv.slice(2);
if (!model?.startsWith("cursor/")) {
  console.error("usage: npm run smoke:cursor -- <cursor/model> [effort]");
  process.exit(2);
}

const key =
  process.env.CURSOR_API_KEY ??
  fs.readFileSync(path.join(os.homedir(), ".cursor", "api_key.txt"), "utf8").trim();
const session = new CursorSession({
  cwd: os.tmpdir(),
  backend: "cursor",
  model,
  effort,
  providerEnv: { CURSOR_API_KEY: key },
});
const reports: unknown[] = [];
session.setPanelTools({
  instructions: "You are a smoke test of the panel's tools.",
  tools: [
    {
      name: "report_progress",
      description: "Tell the lead something.",
      shape: { text: z.string() },
      handler: (args) => {
        reports.push(args);
        return Promise.resolve("Reported.");
      },
    },
  ],
});
session.on("event", (e: StreamEvent) => {
  if (e.kind === "text_delta" || e.kind === "thinking_delta") return;
  console.log(
    `${e.kind}${e.toolName ? ` ${e.toolName}` : ""}: ${JSON.stringify(e.content).slice(0, 120)}`,
  );
});
await session.send(
  "Call the report_progress tool with the text PONG, then reply with the single word PONG.",
);
console.log(`agent: ${session.sessionId}`);
console.log(`report_progress calls: ${JSON.stringify(reports)}`);
console.log(`usage: ${JSON.stringify(session.usage)}`);
process.exit(0);
