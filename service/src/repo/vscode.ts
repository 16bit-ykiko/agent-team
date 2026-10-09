import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// Opens a file in the user's VS Code, connected to this machine over Remote
// (WSL, SSH), through the `code` its server ships. The server runs outside
// any VS Code terminal, so VSCODE_IPC_HOOK_CLI, which tells `code` which
// VS Code to talk to, is not set: the IPC sockets VS Code leaves in the
// runtime dir are tried newest first (dead ones from closed windows stay
// behind, and a live one may not answer). Which window shows the file is
// VS Code's choice: one whose folder holds it, else the last active one.

export class VSCodeUnavailable extends Error {}

export interface VSCodeEnv {
  // ~/.vscode-server, where the remote CLI lives.
  serverDir: string;
  // Where the vscode-ipc-*.sock files are (/run/user/<uid>).
  runtimeDir: string;
  // The hook of a VS Code terminal, when the server was started from one.
  hook?: string;
  // How long one window may take to answer.
  timeoutMs?: number;
}

export function vscodeEnv(): VSCodeEnv {
  const uid = process.getuid?.() ?? 0;
  return {
    serverDir: path.join(os.homedir(), ".vscode-server"),
    runtimeDir: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    ...(process.env.VSCODE_IPC_HOOK_CLI && { hook: process.env.VSCODE_IPC_HOOK_CLI }),
  };
}

export async function openInVSCode(
  file: string,
  line: number | undefined,
  env: VSCodeEnv = vscodeEnv(),
): Promise<void> {
  const cli = newest(remoteClis(env.serverDir));
  if (!cli) throw new VSCodeUnavailable("VS Code's remote CLI is not installed here");
  const sockets = [
    ...(env.hook ? [env.hook] : []),
    ...newestFirst(ipcSockets(env.runtimeDir)).filter((s) => s !== env.hook),
  ];
  const target = line ? `${file}:${line}` : file;
  let failed: Error = new VSCodeUnavailable("No VS Code window is connected");
  for (const hook of sockets) {
    if (!(await alive(hook))) continue;
    try {
      return await run(cli, ["--goto", target], hook, env.timeoutMs ?? 5000);
    } catch (e) {
      failed = e as Error;
    }
  }
  throw failed;
}

// The CLI is a shell script that starts node without exec: on a timeout the
// whole process group goes, or node would stay behind.
function run(cli: string, args: string[], hook: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, VSCODE_IPC_HOOK_CLI: hook },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Gone already.
      }
      reject(new VSCodeUnavailable("VS Code did not answer"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `VS Code's CLI failed (${code ?? signal})`));
    });
  });
}

function remoteClis(serverDir: string): string[] {
  const out: string[] = [];
  // Older servers live under bin/<commit>, newer ones under cli/servers/.
  const dirs = [
    [path.join(serverDir, "bin"), "bin/remote-cli/code"],
    [path.join(serverDir, "cli", "servers"), "server/bin/remote-cli/code"],
  ];
  for (const [dir, rel] of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const cli = path.join(dir, n, rel);
      if (fs.existsSync(cli)) out.push(cli);
    }
  }
  return out;
}

function ipcSockets(runtimeDir: string): string[] {
  try {
    return fs
      .readdirSync(runtimeDir)
      .filter((n) => /^vscode-ipc-.*\.sock$/.test(n))
      .map((n) => path.join(runtimeDir, n));
  } catch {
    return [];
  }
}

function newestFirst(files: string[]): string[] {
  const time = (f: string) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [...files].sort((a, b) => time(b) - time(a));
}

function newest(files: string[]): string | undefined {
  return newestFirst(files)[0];
}

function alive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      c.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1000);
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
}
