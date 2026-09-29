import * as fs from "fs";
import * as path from "path";

// A project: one repository (with any worktrees, on any disk) that a lead
// agent looks after. Its external memory lives here, in the server's data
// directory, not in the repository: structured objectives (objectives.ts)
// and free-form notes the lead (or its subagents) keep as markdown files.
//
//   .agent-team/projects/<id>/project.json
//   .agent-team/projects/<id>/objectives/<area>/<name>.toml
//   .agent-team/projects/<id>/notes/*.md

export interface Project {
  id: string;
  name: string;
  root: string;
  leadWorkspaceId: string | null;
  createdAt: number;
}

export class ProjectStore {
  private dir: string;
  private projects = new Map<string, Project>();

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, ".agent-team", "projects");
    if (!fs.existsSync(this.dir)) return;
    for (const id of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, id, "project.json");
      if (!fs.existsSync(file)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(file, "utf-8")) as Project;
        this.projects.set(p.id, p);
      } catch (e) {
        console.error(`[projects] ${file} unreadable; the project is skipped`, e);
      }
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  notesDir(id: string): string {
    return path.join(this.dir, id, "notes");
  }

  objectivesDir(id: string): string {
    return path.join(this.dir, id, "objectives");
  }

  create(name: string, root: string): Project {
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const project: Project = { id, name, root, leadWorkspaceId: null, createdAt: Date.now() };
    try {
      fs.mkdirSync(this.notesDir(id), { recursive: true });
      fs.mkdirSync(this.objectivesDir(id), { recursive: true });
      this.save(project);
    } catch (e) {
      this.remove(id);
      throw e;
    }
    return project;
  }

  save(project: Project): void {
    this.projects.set(project.id, project);
    this.write(path.join(this.dir, project.id, "project.json"), project);
  }

  // Drops the project with its objectives and notes.
  remove(id: string): void {
    this.projects.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  private write(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
