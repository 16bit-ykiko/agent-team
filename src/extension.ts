import * as vscode from "vscode";
import WebSocket from "ws";

const RECONNECT_DELAY_MS = 3000;

function getPort(): number {
  return vscode.workspace.getConfiguration("agent-team").get<number>("port", 9800);
}

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;
let disposed = false;

interface HostActionMessage {
  type: "host_action";
  action: string;
  args: Record<string, unknown>;
}

function connect(output: vscode.OutputChannel) {
  if (disposed) return;

  const serverUrl = `ws://localhost:${getPort()}`;
  ws = new WebSocket(serverUrl);

  ws.on("open", () => {
    output.appendLine(`[host] connected to ${serverUrl}`);
    ws?.send(JSON.stringify({ type: "register_host" }));
  });

  ws.on("message", (raw) => {
    let msg: HostActionMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "host_action") {
      handleHostAction(msg.action, msg.args ?? {}, output);
    }
  });

  ws.on("close", () => {
    if (disposed) return;
    scheduleReconnect(output);
  });

  ws.on("error", (err) => {
    output.appendLine(`[host] error: ${err.message}`);
  });
}

function scheduleReconnect(output: vscode.OutputChannel) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(output), RECONNECT_DELAY_MS);
}

async function handleHostAction(
  action: string,
  args: Record<string, unknown>,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    switch (action) {
      case "open_file": {
        const uri = vscode.Uri.file(String(args.path));
        await vscode.window.showTextDocument(uri, { preview: false });
        break;
      }

      case "open_diff": {
        const left = vscode.Uri.file(String(args.left));
        const right = vscode.Uri.file(String(args.right));
        const title = String(args.title ?? `${args.left} ↔ ${args.right}`);
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
        break;
      }

      case "reveal_file": {
        const uri = vscode.Uri.file(String(args.path));
        await vscode.commands.executeCommand("revealInExplorer", uri);
        break;
      }

      default:
        output.appendLine(`[host] unknown action: ${action}`);
    }
  } catch (e) {
    output.appendLine(`[host] action ${action} failed: ${e}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Agent Team");
  context.subscriptions.push(output);

  connect(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("agent-team.open", async () => {
      await vscode.commands.executeCommand("simpleBrowser.show", `http://localhost:${getPort()}`);
    }),
    vscode.commands.registerCommand("agent-team.openExternal", () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${getPort()}`));
    }),
  );
}

export function deactivate() {
  disposed = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
