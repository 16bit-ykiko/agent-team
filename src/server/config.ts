import * as fs from "fs";
import * as path from "path";

export interface AgentConfig {
  backend: string;
  model: string;
  effort: string;
  permission_mode: string;
}

export interface AppConfig {
  projects: Record<string, string>;
  agents: Record<string, AgentConfig>;
}

export function loadConfig(baseDir: string): AppConfig {
  const toml = fs.readFileSync(path.join(baseDir, "config.toml"), "utf-8");
  return parseToml(toml);
}

function parseToml(content: string): AppConfig {
  const projects: Record<string, string> = {};
  const agents: Record<string, AgentConfig> = {};

  let currentSection = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*"(.+)"$/);
    if (!kvMatch) continue;
    const [, key, value] = kvMatch;

    if (currentSection === "projects") {
      projects[key] = value;
    } else if (currentSection.startsWith("agents.")) {
      const role = currentSection.split(".")[1];
      if (!agents[role]) {
        agents[role] = { backend: "claude", model: "", effort: "max", permission_mode: "default" };
      }
      (agents[role] as Record<string, string>)[key] = value;
    }
  }

  return { projects, agents };
}
