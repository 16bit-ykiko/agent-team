import * as path from "path";
import { Server } from "./server/server";

const port = parseInt(process.env.AGENT_TEAM_PORT ?? "9800", 10);
const baseDir = process.env.AGENT_TEAM_BASE_DIR ?? process.cwd();
const webDir = process.env.AGENT_TEAM_WEB_DIR ?? path.join(__dirname, "webview");

const server = new Server(port, baseDir, webDir);

function shutdown() {
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, saving state before exit:", err);
  server.close();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection, saving state before exit:", reason);
  server.close();
  process.exit(1);
});
