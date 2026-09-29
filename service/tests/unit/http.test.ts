// Auth and HttpHandler on an ephemeral loopback port: cookie validation,
// login, static files with gzip, uploads and debug snapshots.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { Auth } from "../../src/server/auth";
import { HttpHandler } from "../../src/server/http";
import type { AuthConfig } from "../../src/config/config";

let base: string;
let web: string;
let uploads: string;
let server: http.Server;
let port: number;
let authConfig: AuthConfig | null;
let handler: HttpHandler;

const AUTH: AuthConfig = {
  username: "u",
  password: "p",
  session_secret: "s1",
  max_age_days: 1,
};

function request(
  pathname: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: opts.method ?? "GET",
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const sign = (secret: string, payload: string) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

async function login(): Promise<string> {
  const res = await request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=u&password=p",
  });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("./");
  return String(res.headers["set-cookie"]?.[0]).split(";")[0];
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-http-"));
  web = path.join(base, "web");
  uploads = path.join(base, "uploads");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.mkdirSync(uploads);
  fs.writeFileSync(path.join(web, "index.html"), "<html>app</html>");
  fs.writeFileSync(path.join(web, "assets", "app.js"), "console.log('a');".repeat(200));
  fs.writeFileSync(path.join(web, "logo.png"), "png-bytes");
  authConfig = { ...AUTH };
  const auth = new Auth(() => authConfig);
  handler = new HttpHandler(auth, web, uploads, base);
  server = http.createServer((req, res) => handler.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("session cookies", () => {
  it("accept a fresh login and reject tampered, expired, malformed and re-keyed cookies", async () => {
    const cookie = await login();
    expect((await request("/", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request("/")).status).toBe(302);

    const value = cookie.slice("agent_team_session=".length);
    const [user, expires, sig] = value.split(":");
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    const past = String(Date.now() - 1000);
    const bad = [
      `${user}:${expires}:${flipped}`,
      `${user}:${past}:${sign("s1", `${user}:${past}`)}`,
      `${user}:${expires}`,
      `${user}:soon:${sign("s1", `${user}:soon`)}`,
      `${user}:${expires}:${sig.slice(0, 10)}`,
      `admin:${expires}:${sig}`,
    ];
    for (const v of bad) {
      const res = await request("/", { headers: { Cookie: `agent_team_session=${v}` } });
      expect(res.status, v).toBe(302);
      expect(res.headers.location).toBe("login");
    }
    // Among other cookies, with spaces around it.
    expect((await request("/", { headers: { Cookie: `a=b;  ${cookie} ; c=d` } })).status).toBe(200);

    // config.toml hot-reloads: a new secret signs out every session.
    authConfig = { ...AUTH, session_secret: "s2" };
    expect((await request("/", { headers: { Cookie: cookie } })).status).toBe(302);
    authConfig = { ...AUTH };
  });

  it("show the error on a wrong password, refuse other methods and oversized bodies", async () => {
    const wrong = await request("/login", {
      method: "POST",
      body: "username=u&password=nope",
    });
    expect(wrong.status).toBe(200);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(wrong.body.toString()).toContain("用户名或密码错误");
    expect((await request("/login")).body.toString()).toContain('<form method="POST"');
    expect((await request("/login", { method: "PUT" })).status).toBe(405);
    const big = await request("/login", { method: "POST", body: "x".repeat(20_000) }).catch(() => ({
      status: 413,
    }));
    expect(big.status).toBe(413);
  });

  it("let everything through when auth is off", async () => {
    authConfig = null;
    try {
      expect((await request("/")).status).toBe(200);
      expect((await request("/login")).status).toBe(404);
    } finally {
      authConfig = { ...AUTH };
    }
  });
});

describe("static files", () => {
  it("gzip text assets for clients that accept it, and re-compress after a rebuild", async () => {
    const cookie = await login();
    const file = path.join(web, "assets", "app.js");
    const gz = await request("/assets/app.js", {
      headers: { Cookie: cookie, "Accept-Encoding": "br, gzip" },
    });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers.vary).toBe("Accept-Encoding");
    expect(gz.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(zlib.gunzipSync(gz.body).toString()).toBe(fs.readFileSync(file, "utf-8"));

    const plain = await request("/assets/app.js", { headers: { Cookie: cookie } });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(fs.readFileSync(file, "utf-8"));

    const png = await request("/logo.png", {
      headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
    });
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.headers["content-type"]).toBe("image/png");

    fs.writeFileSync(file, "console.log('rebuilt');");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const again = await request("/assets/app.js", {
      headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
    });
    expect(zlib.gunzipSync(again.body).toString()).toBe("console.log('rebuilt');");
  });

  it("serve index.html at the root, 404 missing files and never leave the web dir", async () => {
    const cookie = await login();
    const root = await request("/", { headers: { Cookie: cookie } });
    expect(root.body.toString()).toBe("<html>app</html>");
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await request("/nope.js", { headers: { Cookie: cookie } })).status).toBe(404);
    fs.writeFileSync(path.join(base, "config.toml"), "secret");
    for (const p of ["/../config.toml", "/%2e%2e/config.toml", "/assets/..%2f..%2fconfig.toml"]) {
      const res = await request(p, { headers: { Cookie: cookie } });
      expect(res.body.toString(), p).not.toContain("secret");
    }
  });

  it("identify the build by index.html", () => {
    expect(handler.buildId()).toBe(
      crypto.createHash("sha1").update("<html>app</html>").digest("hex").slice(0, 12),
    );
  });
});

describe("uploads and snapshots", () => {
  it("store an upload under a fresh name inside uploads/ and serve it back", async () => {
    const cookie = await login();
    const noName = await request("/upload", {
      method: "POST",
      headers: { Cookie: cookie },
      body: "img",
    });
    const a = JSON.parse(noName.body.toString()) as { url: string; name: string };
    expect(a.name).toBe("image.jpg");
    expect(a.url).toMatch(/^uploads\/\d+-[a-z0-9]+\.jpg$/);

    const evil = await request("/upload", {
      method: "POST",
      headers: { Cookie: cookie, "x-filename": "../../escape.sh" },
      body: "#!/bin/sh",
    });
    const b = JSON.parse(evil.body.toString()) as { url: string };
    expect(b.url).toMatch(/^uploads\/\d+-[a-z0-9]+\.sh$/);
    expect(fs.existsSync(path.join(base, "escape.sh"))).toBe(false);
    expect(fs.readFileSync(path.join(uploads, path.basename(b.url)), "utf-8")).toBe("#!/bin/sh");

    const back = await request(`/${a.url}`, { headers: { Cookie: cookie } });
    expect(back.body.toString()).toBe("img");
    expect(back.headers["content-security-policy"]).toBe("sandbox");
    expect((await request("/uploads/none.png", { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await request(`/${a.url}`)).status).toBe(302);
  });

  it("write a layout snapshot under .agent-team/debug", async () => {
    const cookie = await login();
    const res = await request("/debug/snapshot", {
      method: "POST",
      headers: { Cookie: cookie },
      body: '{"x":1}',
    });
    const { path: rel } = JSON.parse(res.body.toString()) as { path: string };
    expect(rel).toMatch(/^\.agent-team\/debug\/snapshot-.*\.json$/);
    expect(fs.readFileSync(path.join(base, rel), "utf-8")).toBe('{"x":1}');
  });
});

describe("file previews", () => {
  let cookie: string;
  let dir: string;
  beforeAll(async () => {
    cookie = await login();
    dir = path.join(base, "preview");
    fs.mkdirSync(dir);
  });
  const get = (route: string, p: string) =>
    request(`/api/${route}?path=${encodeURIComponent(p)}`, { headers: { Cookie: cookie } });

  it("refuse a file that cannot be opened, and keep serving", async () => {
    const locked = path.join(dir, "locked.png");
    fs.writeFileSync(locked, "png");
    fs.chmodSync(locked, 0o000);
    expect((await get("file", locked)).status).toBe(200);
    expect((await get("file/raw", locked)).status).toBe(403);
    expect((await get("file/raw", locked)).status).toBe(403);
    expect((await request("/", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("do not open a pipe or a device, which would block the server", async () => {
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const view = await get("file", fifo);
    expect(view.status).toBe(400);
    expect(JSON.parse(view.body.toString())).toMatchObject({ error: "Not a regular file" });
    expect((await get("file/raw", fifo)).status).toBe(400);
  });

  it("close the file when a download is cancelled", async () => {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024));
    const openOnBig = () =>
      fs.readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return fs.readlinkSync(`/proc/self/fd/${fd}`) === big;
        } catch {
          return false;
        }
      }).length;
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port,
            path: `/api/file/raw?path=${encodeURIComponent(big)}`,
            headers: { Cookie: cookie },
            agent: false,
          },
          (res) => res.once("data", () => (req.destroy(), resolve())),
        );
        req.on("error", reject);
      });
    }
    await vi.waitFor(() => expect(openOnBig()).toBe(0));
  });

  it("list folders first even when the listing is cut short", async () => {
    const crowd = path.join(dir, "crowd");
    fs.mkdirSync(path.join(crowd, "zz-sub"), { recursive: true });
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(crowd, `f${i}`), "");
    const view = JSON.parse((await get("file", crowd)).body.toString()) as {
      entries: Array<{ name: string; dir: boolean }>;
      truncated: boolean;
    };
    expect(view.truncated).toBe(true);
    expect(view.entries[0]).toMatchObject({ name: "zz-sub", dir: true });
  });
});
