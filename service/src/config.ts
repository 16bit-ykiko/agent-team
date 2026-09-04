import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";

export interface ServerConfig {
  remote_uploads_url?: string;
}

export interface WorkspaceConfig {
  // Workspaces idle for this long are archived automatically: their messages
  // leave memory, idle CLI processes are shut down and the sidebar folds them
  // into an "Archived" section. 0 disables the sweep.
  archive_after_days: number;
}

export const DEFAULT_ARCHIVE_AFTER_DAYS = 14;

export interface AuthConfig {
  username: string;
  password: string;
  session_secret: string;
  max_age_days: number;
}

// A named Claude account backed by a long-lived OAuth token from
// `claude setup-token`. The locally logged-in account needs no entry.
export interface AccountConfig {
  oauth_token: string;
}

export interface HostConfig {
  label: string;
  type: "local";
}

export interface ProviderConfig {
  api_key: string;
  base_url: string;
}

export interface AppConfig {
  server: ServerConfig;
  workspace: WorkspaceConfig;
  auth: AuthConfig | null;
  accounts: Record<string, AccountConfig>;
  hosts: Record<string, HostConfig>;
  providers: Record<string, ProviderConfig>;
}

export function loadConfig(baseDir: string): AppConfig {
  const configPath = path.join(baseDir, "config.toml");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nCopy config.example.toml to config.toml to get started.`,
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;

  const serverSection = parsed.server as Record<string, unknown> | undefined;
  const server: ServerConfig = {
    remote_uploads_url: (serverSection?.remote_uploads_url as string) || undefined,
  };

  const wsSection = parsed.workspace as Record<string, unknown> | undefined;
  const archiveDays = wsSection?.archive_after_days;
  const workspace: WorkspaceConfig = {
    archive_after_days:
      typeof archiveDays === "number" && archiveDays >= 0
        ? archiveDays
        : DEFAULT_ARCHIVE_AFTER_DAYS,
  };

  const hosts: Record<string, HostConfig> = {};
  const rawHosts = parsed.hosts;
  if (rawHosts && typeof rawHosts === "object") {
    for (const [id, cfg] of Object.entries(rawHosts as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, string>;
        hosts[id] = {
          label: c.label ?? id,
          type: "local",
        };
      }
    }
  }
  if (Object.keys(hosts).length === 0) {
    hosts["local"] = { label: "Local", type: "local" };
  }

  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = parsed.providers;
  if (rawProviders && typeof rawProviders === "object") {
    for (const [name, cfg] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, string>;
        if (c.api_key && c.base_url) {
          providers[name] = { api_key: c.api_key, base_url: c.base_url };
        }
      }
    }
  }

  let auth: AuthConfig | null = null;
  const rawAuth = parsed.auth as Record<string, unknown> | undefined;
  if (rawAuth?.username && rawAuth?.password && rawAuth?.session_secret) {
    auth = {
      username: rawAuth.username as string,
      password: rawAuth.password as string,
      session_secret: rawAuth.session_secret as string,
      max_age_days: (rawAuth.max_age_days as number) ?? 30,
    };
  }

  const accounts: Record<string, AccountConfig> = {};
  const rawAccounts = parsed.accounts;
  if (rawAccounts && typeof rawAccounts === "object") {
    for (const [name, val] of Object.entries(rawAccounts as Record<string, unknown>)) {
      const c = val as Record<string, string>;
      if (c?.oauth_token) accounts[name] = { oauth_token: c.oauth_token };
    }
  }

  return { server, workspace, auth, hosts, providers, accounts };
}

// Which account a session should run on: an explicit per-agent account wins,
// otherwise the runtime default (when it still exists in config), otherwise
// the local login.
export function effectiveAccount(
  explicit: string | undefined,
  defaultAccount: string | null,
  accounts: Record<string, AccountConfig>,
): string | undefined {
  if (explicit && accounts[explicit]) return explicit;
  if (explicit) return undefined; // stale explicit account: fall back to local
  if (defaultAccount && accounts[defaultAccount]) return defaultAccount;
  return undefined;
}

// Where to fail over when `current` (undefined = local) hits a weekly-type
// limit: the first other configured account, else back to local, else
// nowhere (returns undefined). null = local login.
export function pickFailoverAccount(
  current: string | undefined,
  accounts: Record<string, AccountConfig>,
): string | null | undefined {
  const others = Object.keys(accounts).filter((a) => a !== current);
  if (others.length > 0) return others[0];
  if (current !== undefined) return null;
  return undefined;
}
