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

export interface AppConfig {
  server: ServerConfig;
  projects: Record<string, string>;
  agents: Record<string, AgentConfig>;
}

export function loadConfig(baseDir: string): AppConfig {
  const raw = fs.readFileSync(path.join(baseDir, "config.toml"), "utf-8");
  const parsed = TOML.parse(raw) as Record<string, unknown>;

  const projects: Record<string, string> = {};
  const rawProjects = parsed.projects;
  if (rawProjects && typeof rawProjects === "object") {
    for (const [key, value] of Object.entries(rawProjects)) {
      if (typeof value === "string") projects[key] = value;
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

  return { server, projects, agents };
}
