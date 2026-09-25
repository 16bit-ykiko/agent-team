// Runs the real server (src/index.ts) in a child process against a scratch
// base dir. HOME points at an empty dir and no agents are seeded, so no
// Claude/Codex session can ever start from here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";
import type { Message, WorkspaceState } from "../../src/task";

const ROOT = path.resolve(__dirname, "../../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

let base: string;
let child: ChildProcess;
let port: number;
let remote: http.Server;
let remotePort: number;
let cookie: string;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function request(
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function connect(): Promise<{
  ws: WebSocket;
  next: (type: string) => Promise<Record<string, unknown>>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Cookie: cookie } });
  const inbox: Record<string, unknown>[] = [];
  const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const next = (type: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) resolve(inbox.splice(i, 1)[0]);
      else waiters.push({ type, resolve });
    });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });
}

// 7 messages; each prompt shares its millisecond with the reply after it.
const HISTORY: Message[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
  id: `m${i}`,
  kind: i % 2 ? "agent" : "user",
  agentId: i % 2 ? "a" : null,
  content: `c${i}`,
  timestamp: 1000 + Math.floor(i / 2),
  status: "done",
}));

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-server-"));
  const home = path.join(base, "home");
  const web = path.join(base, "web");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(web, "icons"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<html>app</html>");
  fs.writeFileSync(path.join(web, "secret.jsonl"), "private transcript");
  fs.writeFileSync(path.join(web, "icons", "icon.png"), "png");
  fs.mkdirSync(path.join(web, "assets"));
  fs.writeFileSync(path.join(web, "assets", "KaTeX_Main-Regular-abc123.ttf"), "ttf");

  remote = http.createServer((req, res) => {
    const delay = req.url?.includes("slow") ? 400 : 0;
    setTimeout(() => res.end(`remote:${req.url}`), delay);
  });
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  remotePort = (remote.address() as net.AddressInfo).port;

  fs.writeFileSync(
    path.join(base, "config.toml"),
    `[server]
remote_uploads_url = "http://127.0.0.1:${remotePort}/up"
[auth]
username = "u"
password = "p"
session_secret = "s"
[hosts.local]
label = "Local"
type = "local"
`,
  );
  const cache = path.join(base, ".agent-team", "cache");
  fs.mkdirSync(path.join(cache, "workspaces"), { recursive: true });
  const state: WorkspaceState = {
    id: "ws-h",
    name: "h",
    project: "p",
    hostId: "local",
    cwd: base,
    agents: [],
    createdAt: 1,
    messages: HISTORY,
  };
  fs.writeFileSync(path.join(cache, "workspaces", "ws-h.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(cache, "index.json"), JSON.stringify({ workspaceIds: ["ws-h"] }));

  port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_TEAM_PORT: String(port),
    AGENT_TEAM_BASE_DIR: base,
    AGENT_TEAM_WEB_DIR: web,
  };
  child = spawn(TSX, [path.join(ROOT, "service/src/index.ts")], { env, cwd: base });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });

  const login = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=u&password=p",
  });
  cookie = String(login.headers["set-cookie"]?.[0]).split(";")[0];
}, 30000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await new Promise<void>((r) => remote?.close(() => r()));
  fs.rmSync(base, { recursive: true, force: true });
});

describe("server auth", () => {
  it("serves icons publicly but not files reached through them", async () => {
    const icon = await request("/icons/icon.png");
    expect(icon.status).toBe(200);
    expect(icon.headers["cache-control"]).toBe("public, max-age=86400");
    for (const p of [
      "/icons/..%2fsecret.jsonl",
      "/icons/../secret.jsonl",
      "/icons/%2e%2e/index.html",
    ]) {
      const res = await request(p);
      expect(res.status, p).toBe(302);
      expect(res.body).not.toContain("private");
    }
  });

  it("caches content-hashed assets for good, fonts included", async () => {
    const font = await request("/assets/KaTeX_Main-Regular-abc123.ttf", {
      headers: { Cookie: cookie },
    });
    expect(font.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(font.headers["content-type"]).toBe("font/ttf");
  });

  it("serves uploads sandboxed so they cannot script the app", async () => {
    const up = await request("/upload", {
      method: "POST",
      headers: { Cookie: cookie, "x-filename": "x.html" },
      body: "<script>alert(1)</script>",
    });
    const { url } = JSON.parse(up.body) as { url: string };
    const res = await request(`/${url}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("server websocket", () => {
  it("survives a malformed frame from an authenticated client", async () => {
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Cookie: ${cookie}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      s.once("data", (d: Buffer) => {
        if (!d.toString().startsWith("HTTP/1.1 101")) reject(new Error(d.toString()));
        // Masked text frame whose payload is invalid UTF-8.
        s.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0xff]));
        s.on("close", () => resolve());
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(child.exitCode).toBeNull();
    expect((await request("/", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("pages back through history without skipping same-millisecond messages", async () => {
    const { ws, next } = await connect();
    const seen: Message[] = [];
    let before: number | undefined;
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: "load_messages", workspaceId: "ws-h", before, limit: 2 }));
      const page = await next("workspace_messages");
      const known = new Set(seen.map((m) => m.id));
      seen.unshift(...(page.messages as Message[]).filter((m) => !known.has(m.id)));
      if (!page.hasMore) break;
      before = seen[0].timestamp;
    }
    ws.close();
    expect(seen.map((m) => m.id)).toEqual(HISTORY.map((m) => m.id));
  });

  it("downloads missing images from the remote uploads host without a shell", async () => {
    const { ws, next } = await connect();
    const uploads = path.join(base, "uploads");
    ws.send(
      JSON.stringify({
        type: "send_message",
        workspaceId: "missing",
        content: "hi",
        images: [
          { name: "a", url: "uploads/a.png" },
          { name: "b", url: "uploads/$(touch pwned).png" },
        ],
      }),
    );
    await next("error");
    ws.close();
    expect(fs.readFileSync(path.join(uploads, "a.png"), "utf-8")).toBe("remote:/up/a.png");
    expect(fs.existsSync(path.join(base, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(uploads, "$(touch pwned).png"))).toBe(false);
  });

  it("keeps the order of sends when one waits on an image download", async () => {
    const { ws, next } = await connect();
    const send = (content: string, images?: Array<{ name: string; url: string }>) =>
      ws.send(JSON.stringify({ type: "send_message", workspaceId: "ws-h", content, images }));
    send("@first look at this", [{ name: "s", url: "uploads/slow.png" }]);
    send("@second then fix it");
    const errors = [(await next("error")).message, (await next("error")).message];
    ws.close();
    expect(errors).toEqual(["Agent not found: first", "Agent not found: second"]);
  });
});
