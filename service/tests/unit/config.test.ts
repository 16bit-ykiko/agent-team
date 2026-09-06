import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, effectiveAccount, pickFailoverAccount } from "../../src/config";
import { loadSettings, saveSettings } from "../../src/state";

let dir: string;

function writeConfig(toml: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  fs.writeFileSync(path.join(d, "config.toml"), toml);
  return d;
}

beforeAll(() => {
  dir = writeConfig(`
[server]
port = 9800

[hosts.local]
label = "Local"
type = "local"

[accounts.work]
oauth_token = "sk-ant-oat01-work-token"

[accounts.side]
oauth_token = "sk-ant-oat01-side-token"

[accounts.broken]
note = "no token here"
`);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig accounts", () => {
  it("parses named accounts with oauth tokens and skips entries without one", () => {
    const config = loadConfig(dir);
    expect(Object.keys(config.accounts).sort()).toEqual(["side", "work"]);
    expect(config.accounts.work.oauth_token).toBe("sk-ant-oat01-work-token");
    expect(config.accounts.side.oauth_token).toBe("sk-ant-oat01-side-token");
  });

  it("defaults to no accounts when the section is absent", () => {
    const d = writeConfig(`
[hosts.local]
label = "Local"
type = "local"
`);
    try {
      expect(loadConfig(d).accounts).toEqual({});
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("effectiveAccount", () => {
  const accounts = { work: { oauth_token: "t1" }, side: { oauth_token: "t2" } };

  it("prefers the agent's explicit account", () => {
    expect(effectiveAccount("side", "work", accounts)).toBe("side");
  });

  it("falls back to local when the explicit account no longer exists", () => {
    expect(effectiveAccount("gone", "work", accounts)).toBeUndefined();
  });

  it("applies the runtime default when the agent has no explicit account", () => {
    expect(effectiveAccount(undefined, "work", accounts)).toBe("work");
    expect(effectiveAccount(undefined, null, accounts)).toBeUndefined();
  });

  it("ignores a default that was removed from config", () => {
    expect(effectiveAccount(undefined, "gone", accounts)).toBeUndefined();
  });
});

describe("runtime settings", () => {
  it("round-trips the default account", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
    try {
      expect(loadSettings(d)).toEqual({});
      saveSettings(d, { defaultAccount: "work" });
      expect(loadSettings(d).defaultAccount).toBe("work");
      saveSettings(d, { defaultAccount: null });
      expect(loadSettings(d).defaultAccount).toBeNull();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("pickFailoverAccount", () => {
  const accounts = { work: { oauth_token: "t1" } };

  it("moves local to the first configured account", () => {
    expect(pickFailoverAccount(undefined, accounts)).toBe("work");
  });

  it("moves an exhausted account back to local", () => {
    expect(pickFailoverAccount("work", accounts)).toBeNull();
  });

  it("prefers another account over local when several exist", () => {
    expect(
      pickFailoverAccount("work", { work: { oauth_token: "t1" }, side: { oauth_token: "t2" } }),
    ).toBe("side");
  });

  it("returns undefined when only local exists and local is exhausted", () => {
    expect(pickFailoverAccount(undefined, {})).toBeUndefined();
  });
});

describe("workspace housekeeping config", () => {
  it("defaults archive_after_days to 14 and accepts an override (0 disables)", () => {
    expect(loadConfig(dir).workspace.archive_after_days).toBe(14);
    const d = writeConfig(`[workspace]\narchive_after_days = 0\n`);
    expect(loadConfig(d).workspace.archive_after_days).toBe(0);
    const d2 = writeConfig(`[workspace]\narchive_after_days = 30\n`);
    expect(loadConfig(d2).workspace.archive_after_days).toBe(30);
  });
});
