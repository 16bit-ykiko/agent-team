import * as crypto from "crypto";
import type * as http from "http";
import type { AuthConfig } from "../config/config";

// Cookie sessions for the one configured user. The config is read on every
// call: config.toml hot-reloads.
export class Auth {
  constructor(private config: () => AuthConfig | null) {}

  get enabled(): boolean {
    return !!this.config();
  }

  isAuthenticated(req: http.IncomingMessage): boolean {
    if (!this.config()) return true;
    const token = parseCookies(req.headers.cookie)["agent_team_session"];
    return !!token && this.validateSessionCookie(token);
  }

  handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(LOGIN_PAGE);
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 8192) {
          res.statusCode = 413;
          res.end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(body);
        const auth = this.config()!;
        if (params.get("username") === auth.username && params.get("password") === auth.password) {
          const cookie = this.makeSessionCookie();
          const maxAge = auth.max_age_days * 86400;
          res.setHeader(
            "Set-Cookie",
            `agent_team_session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
          );
          res.statusCode = 302;
          // Relative: the app may live under a reverse-proxy prefix, and a
          // home-screen app that navigates outside its manifest scope gets
          // Safari's toolbar back.
          res.setHeader("Location", "./");
          res.end();
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            LOGIN_PAGE.replace(
              "<!--ERROR-->",
              '<p style="color:#ff6b6b;margin:0 0 16px">用户名或密码错误</p>',
            ),
          );
        }
      });
      return;
    }

    res.statusCode = 405;
    res.end();
  }

  private signToken(payload: string): string {
    const auth = this.config();
    if (!auth) return "";
    return crypto.createHmac("sha256", auth.session_secret).update(payload).digest("hex");
  }

  private makeSessionCookie(): string {
    const auth = this.config()!;
    const expires = Date.now() + auth.max_age_days * 86400_000;
    const payload = `${auth.username}:${expires}`;
    const sig = this.signToken(payload);
    return `${payload}:${sig}`;
  }

  private validateSessionCookie(cookie: string): boolean {
    if (!this.config()) return true;
    const parts = cookie.split(":");
    if (parts.length !== 3) return false;
    const [user, expiresStr, sig] = parts;
    const expires = parseInt(expiresStr);
    if (isNaN(expires) || Date.now() > expires) return false;
    const expected = this.signToken(`${user}:${expiresStr}`);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return result;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Agents">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<title>Login — Agent Team</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;width:320px}
h2{text-align:center;margin-bottom:24px;font-size:20px;color:#e6edf3}
label{display:block;font-size:13px;margin-bottom:6px;color:#8b949e}
input{width:100%;padding:10px 12px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#c9d1d9;font-size:15px;margin-bottom:16px;outline:none}
input:focus{border-color:#58a6ff}
button{width:100%;padding:10px;border:none;border-radius:6px;background:#238636;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:active{background:#2ea043}
</style>
</head><body>
<form method="POST" action="login">
<h2>Agent Team</h2>
<!--ERROR-->
<label>Username</label><input name="username" autocomplete="username" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">Login</button>
</form>
</body></html>`;
