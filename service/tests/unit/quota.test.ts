// QuotaMonitor with https/http stubbed (no request leaves the process) and
// HOME pointed at a scratch dir holding a fake local login.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Reply = { headers: Record<string, string>; delay?: number } | "error" | "timeout";

const net = vi.hoisted(() => ({
  replies: new Map<string, Reply>(),
  requests: [] as string[],
}));

vi.mock("https", () => {
  const request = (
    _url: unknown,
    opts: { headers: Record<string, string> },
    onResponse: (res: unknown) => void,
  ) => {
    const token = opts.headers["x-api-key"];
    net.requests.push(token);
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => req.emit("error", new Error("destroyed")),
      end: () => {
        const reply = net.replies.get(token) ?? "error";
        const delay = typeof reply === "object" ? (reply.delay ?? 0) : 0;
        setTimeout(() => {
          if (reply === "error") req.emit("error", new Error("down"));
          else if (reply === "timeout") req.emit("timeout");
          else onResponse({ headers: reply.headers, resume: () => {} });
        }, delay);
      },
    });
    return req;
  };
  return { request, default: { request } };
});
vi.mock("http", () => {
  const request = () => {
    throw new Error("the quota probe must not go through a proxy in this test");
  };
  return { request, default: { request } };
});

import { QuotaMonitor } from "../../src/server/quota";

const flush = () => new Promise((r) => setTimeout(r, 5));
const ENV_KEYS = ["HOME", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  // Keys are restored one by one: replacing process.env itself detaches it
  // from the real environment os.homedir() reads.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-quota-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok-local" } }),
  );
  process.env.HOME = home;
  net.replies.clear();
  net.requests.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const window = (u: string, reset: string) => ({
  utilization: parseFloat(u),
  resetsAt: Number(reset),
});

describe("QuotaMonitor", () => {
  it("reads both windows per credential, skips failures and sorts by label", async () => {
    net.replies.set("tok-local", {
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "1700000000",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": "1700500000",
      },
    });
    net.replies.set("tok-b", {
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": "1700000001",
      },
    });
    net.replies.set("tok-c", "error");
    const q = new QuotaMonitor(() => ({
      zeta: { oauth_token: "tok-b" },
      alpha: { oauth_token: "tok-c" },
      empty: { oauth_token: "" },
    }));
    q.refreshIfStale();
    await flush();
    expect(net.requests.sort()).toEqual(["tok-b", "tok-c", "tok-local"]);
    expect(q.entries.map((e) => e.label)).toEqual(["local", "zeta"]);
    expect(q.entries[0]).toMatchObject({
      fiveHour: window("0.25", "1700000000"),
      sevenDay: window("0.5", "1700500000"),
    });
    expect(q.entries[1]).toMatchObject({ fiveHour: window("1", "1700000001"), sevenDay: null });
  });

  it("counts a timed-out probe once, publishing only when every probe is back", async () => {
    net.replies.set("tok-local", "timeout");
    net.replies.set("tok-a", {
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
        "anthropic-ratelimit-unified-5h-reset": "1",
      },
      delay: 20,
    });
    const q = new QuotaMonitor(() => ({ a: { oauth_token: "tok-a" } }));
    q.refreshIfStale();
    await flush();
    expect(q.entries).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    // timeout + the error from destroy() must not count as two finished
    // probes, or the list is published early and the late one never lands.
    expect(q.entries.map((e) => e.label)).toEqual(["a"]);
  });

  it("probes at most every five minutes unless invalidated", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(10_000_000);
      net.replies.set("tok-local", { headers: {} });
      const q = new QuotaMonitor(() => ({}));
      q.refreshIfStale();
      q.refreshIfStale();
      expect(net.requests).toHaveLength(1);
      vi.setSystemTime(10_000_000 + 4 * 60_000);
      q.refreshIfStale();
      expect(net.requests).toHaveLength(1);
      q.invalidate();
      q.refreshIfStale();
      expect(net.requests).toHaveLength(2);
      vi.setSystemTime(10_000_000 + 4 * 60_000 + 5 * 60_000);
      q.refreshIfStale();
      expect(net.requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no request without any credential", () => {
    fs.rmSync(path.join(home, ".claude"), { recursive: true });
    const q = new QuotaMonitor(() => ({}));
    q.refreshIfStale();
    expect(net.requests).toEqual([]);
  });
});
