import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";

export interface AgentConfig {
  backend: string;
  model: string;
  effort: string;
  permission_mode: string;
}

export interface ServerConfig {
  remote_uploads_url?: string;
}

export interface AuthConfig {
  username: string;
  password: string;
  session_secret: string;
  max_age_days: number;
}

export interface HostConfig {
  label: string;
  type: "local";
  distro?: string;
}

export interface ProviderConfig {
  api_key: string;
  base_url: string;
}

export interface AppConfig {
  server: ServerConfig;
  auth: AuthConfig | null;
  projects: Record<string, Record<string, string>>;
  agents: Record<string, AgentConfig>;
  hosts: Record<string, HostConfig>;
  providers: Record<string, ProviderConfig>;
}

export function loadConfig(baseDir: string): AppConfig {
  const raw = fs.readFileSync(path.join(baseDir, "config.toml"), "utf-8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;

  const projects: Record<string, Record<string, string>> = {};
  const rawProjects = parsed.projects;
  if (rawProjects && typeof rawProjects === "object") {
    for (const [name, val] of Object.entries(rawProjects as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const paths: Record<string, string> = {};
        for (const [hostId, p] of Object.entries(val as Record<string, unknown>)) {
          if (typeof p === "string") paths[hostId] = p;
        }
        if (Object.keys(paths).length > 0) projects[name] = paths;
      } else if (typeof val === "string") {
        projects[name] = { local: val };
      }
    }
  }

  const agents: Record<string, AgentConfig> = {};
  const rawAgents = parsed.agents;
  if (rawAgents && typeof rawAgents === "object") {
    for (const [role, cfg] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object") {
        const c = cfg as Record<string, string>;
        agents[role] = {
          backend: c.backend ?? "claude",
          model: c.model ?? "",
          effort: c.effort ?? "max",
          permission_mode: c.permission_mode ?? "default",
        };
      }
    }
  }

  const serverSection = parsed.server as Record<string, unknown> | undefined;
  const server: ServerConfig = {
    remote_uploads_url: (serverSection?.remote_uploads_url as string) || undefined,
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
          distro: c.distro || undefined,
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

  return { server, auth, projects, agents, hosts, providers };
}
