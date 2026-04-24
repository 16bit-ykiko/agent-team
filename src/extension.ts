import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess, spawn } from "child_process";

const SERVER_PORT = 9800;
let panel: vscode.WebviewPanel | undefined;
let serverProc: ChildProcess | undefined;

function startServer(extensionPath: string): ChildProcess {
  const serverEntry = path.join(extensionPath, "dist", "server.js");
  const proc = spawn("node", [serverEntry], {
    env: {
      ...process.env,
      AGENT_TEAM_PORT: String(SERVER_PORT),
      AGENT_TEAM_BASE_DIR: extensionPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d) => console.log(`[server] ${d.toString().trimEnd()}`));
  proc.stderr?.on("data", (d) => console.error(`[server] ${d.toString().trimEnd()}`));
  proc.on("exit", (code) => console.log(`[server] exited with code ${code}`));

  return proc;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = path.join(extensionUri.fsPath, "dist", "webview");
  const indexHtml = path.join(distPath, "index.html");

  if (!fs.existsSync(indexHtml)) {
    return `<!DOCTYPE html><html><body><p>Webview not built. Run <code>pixi run build</code>.</p></body></html>`;
  }

  let html = fs.readFileSync(indexHtml, "utf-8");

  html = html.replace(
    /(href|src)="(\.?\/?)(assets\/[^"]+)"/g,
    (_match, attr, _prefix, assetPath) => {
      const uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "dist", "webview", assetPath),
      );
      return `${attr}="${uri}"`;
    },
  );

  // Inject server port so webview can connect
  html = html.replace(
    "</head>",
    `<script>window.__AGENT_TEAM_PORT__=${SERVER_PORT};</script></head>`,
  );

  return html;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-team.open", () => {
      if (panel) {
        panel.reveal();
        return;
      }

      if (!serverProc || serverProc.exitCode !== null) {
        serverProc = startServer(context.extensionUri.fsPath);
      }

      panel = vscode.window.createWebviewPanel("agent-team", "Agent Team", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      });

      panel.webview.html = getHtml(panel.webview, context.extensionUri);

      panel.onDidDispose(() => {
        panel = undefined;
      });
    }),
  );
}

export function deactivate() {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
  }
}
