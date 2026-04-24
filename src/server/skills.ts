import * as fs from "fs";
import * as path from "path";

export interface SkillDef {
  name: string;
  icon: string;
  description: string;
  placeholder?: string;
  target?: string;
  template: string;
}

export function loadSkills(baseDir: string): SkillDef[] {
  const dir = path.join(baseDir, ".skills");
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const skills: SkillDef[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const skill = parseSkillFile(file, raw);
      if (skill) skills.push(skill);
    } catch {
      // skip malformed files
    }
  }

  return skills;
}

function parseSkillFile(filename: string, raw: string): SkillDef | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const template = match[2].trim();
  const name = filename.replace(/\.md$/, "");

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) {
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      val = val.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) =>
        String.fromCodePoint(parseInt(hex, 16)),
      );
      fields[m[1]] = val;
    }
  }

  if (!fields.icon || !fields.description) return null;

  return {
    name,
    icon: fields.icon,
    description: fields.description,
    placeholder: fields.placeholder,
    target: fields.target,
    template,
  };
}
