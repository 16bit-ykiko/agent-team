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

export interface HostConfig {
  label: string;
  type: "local";
  distro?: string;
}

export interface AppConfig {
  server: ServerConfig;
  projects: Record<string, Record<string, string>>;
  agents: Record<string, AgentConfig>;
  hosts: Record<string, HostConfig>;
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

  return { server, projects, agents, hosts };
}
