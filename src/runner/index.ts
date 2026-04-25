import { WebSocket } from "ws";
import { ClaudeSession, SessionConfig, StreamEvent, SessionState } from "../server/session";

const args = parseArgs(process.argv.slice(2));
const serverUrl = args.server || "ws://localhost:9800";
const hostId = args["host-id"] || args.hostId;
const token = args.token;

if (!hostId || !token) {
  console.error("Usage: node runner.js --server ws://HOST:PORT --host-id ID --token TOKEN");
  process.exit(1);
}

const sessions = new Map<string, ClaudeSession>();
let ws: WebSocket | null = null;
let reconnectDelay = 1000;

function sendJson(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "auth_ok":
      console.log(`[runner] Authenticated as "${hostId}"`);
      reconnectDelay = 1000;
      break;

    case "auth_fail":
      console.error(`[runner] Auth failed: ${msg.message}`);
      process.exit(1);
      break;

    case "create_session": {
      const agentId = msg.agentId as string;
      const config = msg.config as SessionConfig;
      const resumeState = msg.resumeState as SessionState | undefined;

      let session: ClaudeSession;
      if (resumeState) {
        session = ClaudeSession.fromState(resumeState);
      } else {
        session = new ClaudeSession(config);
      }

      sessions.set(agentId, session);
      sendJson({ type: "session_created", agentId, sessionId: session.sessionId });
      console.log(`[runner] Session created for agent ${agentId}`);
      break;
    }

    case "send_message": {
      const agentId = msg.agentId as string;
      const message = msg.message as string;
      const session = sessions.get(agentId);
      if (!session) {
        sendJson({ type: "session_done", agentId, status: "error", error: "Session not found" });
        break;
      }

      const eventHandler = (event: StreamEvent) => {
        sendJson({ type: "session_event", agentId, event });
      };

      session.on("event", eventHandler);

      session
        .send(message)
        .then(() => {
          session.off("event", eventHandler);
          sendJson({ type: "session_done", agentId, status: "ok" });
          sendJson({ type: "session_state", agentId, state: session.getState() });
        })
        .catch((err) => {
          session.off("event", eventHandler);
          sendJson({
            type: "session_done",
            agentId,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          sendJson({ type: "session_state", agentId, state: session.getState() });
        });
      break;
    }

    case "abort_session": {
      const agentId = msg.agentId as string;
      sessions.get(agentId)?.abort();
      break;
    }

    case "destroy_session": {
      const agentId = msg.agentId as string;
      const session = sessions.get(agentId);
      if (session) {
        session.abort();
        sessions.delete(agentId);
        console.log(`[runner] Session destroyed for agent ${agentId}`);
      }
      break;
    }
  }
}

function connect(): void {
  console.log(`[runner] Connecting to ${serverUrl}...`);
  ws = new WebSocket(serverUrl);

  ws.on("open", () => {
    console.log(`[runner] Connected, registering as "${hostId}"...`);
    sendJson({ type: "register_runner", hostId, token });
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleServerMessage(msg);
    } catch {
      // ignore malformed
    }
  });

  ws.on("close", () => {
    ws = null;
    console.log(`[runner] Disconnected, reconnecting in ${reconnectDelay}ms...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on("error", (err) => {
    console.error(`[runner] WebSocket error: ${err.message}`);
    ws?.close();
  });
}

connect();

function shutdown(): void {
  console.log("[runner] Shutting down...");
  for (const session of sessions.values()) {
    session.abort();
  }
  ws?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}
