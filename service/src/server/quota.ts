import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import type { AccountConfig } from "../config/config";

export interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

export interface QuotaEntry {
  label: string;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  fetchedAt: number;
}

// The quota probe is a real (1-token) API request per account; only made
// while someone is looking, and at most this often.
const QUOTA_INTERVAL_MS = 5 * 60_000;

// Rate-limit utilisation of the local login and every configured account,
// read from the headers of a minimal API request.
export class QuotaMonitor {
  entries: QuotaEntry[] = [];
  private refreshedAt = 0;

  constructor(private accounts: () => Record<string, AccountConfig>) {}

  refreshIfStale(): void {
    if (Date.now() - this.refreshedAt < QUOTA_INTERVAL_MS) return;
    this.refresh();
  }

  // The accounts changed: the next check refreshes.
  invalidate(): void {
    this.refreshedAt = 0;
  }

  private refresh(): void {
    this.refreshedAt = Date.now();
    const sources: Array<{ label: string; token: string }> = [];

    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, "utf-8")) as {
        claudeAiOauth?: { accessToken?: string };
      } | null;
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) sources.push({ label: "local", token });
    } catch {}

    for (const [name, acc] of Object.entries(this.accounts())) {
      if (acc.oauth_token) sources.push({ label: name, token: acc.oauth_token });
    }
    if (sources.length === 0) return;

    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    const results: QuotaEntry[] = [];
    let done = 0;
    for (const src of sources) {
      // A timeout fires both 'timeout' and the 'error' from destroy().
      let reported = false;
      this.fetchForToken(src.token, body, (entry) => {
        if (reported) return;
        reported = true;
        if (entry) results.push({ ...entry, label: src.label });
        if (++done === sources.length) {
          results.sort((a, b) => a.label.localeCompare(b.label));
          this.entries = results;
        }
      });
    }
  }

  private fetchForToken(token: string, body: string, cb: (entry: QuotaEntry | null) => void): void {
    const apiHeaders = {
      "x-api-key": token,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    const handleResponse = (res: http.IncomingMessage) => {
      res.resume();
      const h5 = res.headers["anthropic-ratelimit-unified-5h-utilization"];
      const h5reset = res.headers["anthropic-ratelimit-unified-5h-reset"];
      const d7 = res.headers["anthropic-ratelimit-unified-7d-utilization"];
      const d7reset = res.headers["anthropic-ratelimit-unified-7d-reset"];

      cb({
        label: "",
        fiveHour: h5 ? { utilization: parseFloat(h5 as string), resetsAt: Number(h5reset) } : null,
        sevenDay: d7 ? { utilization: parseFloat(d7 as string), resetsAt: Number(d7reset) } : null,
        fetchedAt: Date.now(),
      });
    };

    const proxy =
      process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.HTTP_PROXY;

    if (proxy) {
      try {
        const proxyUrl = new URL(proxy);
        const proxyReq = http.request({
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          method: "CONNECT",
          path: "api.anthropic.com:443",
          timeout: 10000,
        });
        proxyReq.on("connect", (_res, socket) => {
          const req = https.request(
            {
              hostname: "api.anthropic.com",
              path: "/v1/messages",
              method: "POST",
              headers: apiHeaders,
              socket,
              agent: false,
            } as https.RequestOptions,
            handleResponse,
          );
          req.on("error", () => cb(null));
          req.write(body);
          req.end();
        });
        proxyReq.on("error", () => cb(null));
        proxyReq.on("timeout", () => {
          proxyReq.destroy();
          cb(null);
        });
        proxyReq.end();
      } catch {
        cb(null);
      }
    } else {
      const req = https.request(
        "https://api.anthropic.com/v1/messages",
        { method: "POST", headers: apiHeaders, timeout: 10000 },
        handleResponse,
      );
      req.on("error", () => cb(null));
      req.on("timeout", () => {
        req.destroy();
        cb(null);
      });
      req.write(body);
      req.end();
    }
  }
}
