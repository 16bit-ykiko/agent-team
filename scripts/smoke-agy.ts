// Prove an agy model works through the server's own session
// (service/src/session/agy.ts), panel tools included: one message in a fresh
// temp folder (agy writes in its folder unasked), and the events it maps to.
// Spends the user's Gemini quota: one run at a time, never in a loop.
// Usage: npm run smoke:agy -- <agy/model> [effort]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { StreamEvent } from "../service/src/session/claude.ts";
import { AgySession } from "../service/src/session/agy.ts";

const [model, effort] = process.argv.slice(2);
if (!model?.startsWith("agy/")) {
  console.error("usage: npm run smoke:agy -- <agy/model> [effort]");
  process.exit(2);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smoke-"));
const session = new AgySession({ cwd, backend: "agy", model, effort });
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
  if (e.kind !== "result" && e.kind !== "error") return;
  console.log(`conversation: ${session.sessionId}`);
  console.log(`report_progress calls: ${JSON.stringify(reports)}`);
  console.log(`usage: ${JSON.stringify(session.usage)}`);
  console.log(`folder ${cwd}: ${JSON.stringify(fs.readdirSync(cwd))}`);
  session.abort();
  process.exit(e.kind === "result" ? 0 : 1);
});
await session.send(
  "Call the report_progress tool with the text PONG, then reply with the single word PONG.",
);
