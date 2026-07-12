import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig } from "../src/config";

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
