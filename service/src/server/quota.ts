import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import type { AccountConfig } from "../config/config";
import { readCodexRateLimits } from "../session/codex";
import { agyBinary } from "../session/acp";
import type { RateLimitSnapshot } from "../session/codex-rpc";

export interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

export interface QuotaEntry {
  label: string;
  // Absent: a Claude login (entries from before it was added).
  source?: "claude" | "codex" | "agy";
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  fetchedAt: number;
}

// The quota probe is a real (1-token) API request per account; only made
// while someone is looking, and at most this often.
const QUOTA_INTERVAL_MS = 5 * 60_000;
// agy's is a process of its own (`agy -p /quota`, no model call, ~6 s):
// only while agy agents exist, and less often.
const AGY_INTERVAL_MS = 10 * 60_000;
const AGY_TIMEOUT_MS = 60_000;

// agy's pools by the name `/quota` gives them, Gemini first.
const AGY_POOLS: Array<[string, string]> = [
  ["Gemini Models", "Gemini"],
  ["Claude and GPT models", "agy Claude/GPT"],
];

// `agy -p /quota` prints a line per pool and window: "<pool>\t<Weekly|Five
// Hour> Limit Remaining\t<n>%\t<reset, ISO 8601>".
export function parseAgyQuota(stdout: string, now = Date.now()): QuotaEntry[] {
  const pools = new Map<string, QuotaEntry>();
  for (const line of stdout.split("\n")) {
    const [pool, window, remaining, reset] = line.trim().split("\t");
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(remaining ?? "")?.[1];
    const at = Date.parse(reset ?? "");
    const label = AGY_POOLS.find(([name]) => name === pool)?.[1];
    if (!label || pct === undefined || Number.isNaN(at)) continue;
    const entry = pools.get(label) ?? {
      label,
      source: "agy" as const,
      fiveHour: null,
      sevenDay: null,
      fetchedAt: now,
    };
    const value = { utilization: 1 - Number(pct) / 100, resetsAt: Math.round(at / 1000) };
    if (/^Weekly/i.test(window)) entry.sevenDay = value;
    else if (/^Five Hour/i.test(window)) entry.fiveHour = value;
    else continue;
    pools.set(label, entry);
  }
  return AGY_POOLS.flatMap(([, label]) => pools.get(label) ?? []);
}

// One `agy -p /quota` in an empty folder of its own, its log there too.
export function readAgyQuota(): Promise<QuotaEntry[] | null> {
  // A test that forgot its stand-in would run the real agy.
  if (process.env.VITEST) return Promise.resolve(null);
  let dir: string;
  let bin: string;
  try {
    bin = agyBinary();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-agy-quota-"));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const child = spawn(bin, ["-p", "/quota", "--log-file", path.join(dir, "agy.log")], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    let settled = false;
    // Killed at the deadline, and given up on even if a child of agy's
    // still holds its output open.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, AGY_TIMEOUT_MS);
    const done = (entries: QuotaEntry[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rm(dir, { recursive: true, force: true }, () => {});
      resolve(entries);
    };
    child.on("error", () => done(null));
    child.on("close", (code) => {
      const entries = code === 0 ? parseAgyQuota(out) : [];
      done(entries.length ? entries : null);
    });
  });
}

// Rate-limit utilisation of the local login and every configured account,
// read from the headers of a minimal API request, and of the Codex login,
// from its sessions' updates or a read of our own.
export class QuotaMonitor {
  private claude: QuotaEntry[] = [];
  private codex: QuotaEntry | null = null;
  private agy: QuotaEntry[] = [];
  private refreshedAt = 0;
  private agyReadAt = 0;
  private agyReading = false;

  constructor(
    private accounts: () => Record<string, AccountConfig>,
    private codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    // Whether any agy agent exists, and how agy's quota is read.
    private agyAgents: () => boolean = () => false,
    private agyRead: () => Promise<QuotaEntry[] | null> = readAgyQuota,
  ) {}

  get entries(): QuotaEntry[] {
    return [...this.claude, ...(this.codex ? [this.codex] : []), ...this.agy];
  }

  noteCodex(limits: RateLimitSnapshot): void {
    const entry: QuotaEntry = {
      label: "Codex",
      source: "codex",
      fiveHour: null,
      sevenDay: null,
      fetchedAt: Date.now(),
    };
    for (const w of [limits.primary, limits.secondary]) {
      if (!w?.resetsAt) continue;
      const window = { utilization: w.usedPercent / 100, resetsAt: w.resetsAt };
      if ((w.windowDurationMins ?? 0) <= 24 * 60) entry.fiveHour = window;
      else entry.sevenDay = window;
    }
    this.codex = entry;
  }

  refreshIfStale(): void {
    this.refreshAgyIfStale();
    if (Date.now() - this.refreshedAt < QUOTA_INTERVAL_MS) return;
    this.refresh();
  }

  // Never two at once; the pools go from the display with the last agent.
  private refreshAgyIfStale(): void {
    if (!this.agyAgents()) {
      this.agy = [];
      // The next agy agent gets its pools read at once.
      this.agyReadAt = 0;
      return;
    }
    if (this.agyReading || Date.now() - this.agyReadAt < AGY_INTERVAL_MS) return;
    this.agyReading = true;
    this.agyReadAt = Date.now();
    void this.agyRead()
      .then((entries) => {
        if (entries && this.agyAgents()) this.agy = entries;
      })
      .catch(() => {})
      .finally(() => {
        this.agyReading = false;
      });
  }

  // The accounts changed: the next check refreshes.
  invalidate(): void {
    this.refreshedAt = 0;
  }

  private refresh(): void {
    this.refreshedAt = Date.now();
    // A read costs no quota; sessions' updates spare even that.
    const fresh = this.codex && Date.now() - this.codex.fetchedAt < QUOTA_INTERVAL_MS;
    if (!fresh && fs.existsSync(path.join(this.codexHome, "auth.json"))) {
      const before = this.codex;
      // A session's update while the read ran is the newer one.
      void readCodexRateLimits().then((limits) => {
        if (limits && this.codex === before) this.noteCodex(limits);
      });
    }
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
        if (entry) results.push({ ...entry, label: src.label, source: "claude" });
        if (++done === sources.length) {
          results.sort((a, b) => a.label.localeCompare(b.label));
          this.claude = results;
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
