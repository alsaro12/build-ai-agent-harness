import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

function parseFrontmatter(md: string): { description?: string } {
  if (!md.startsWith("---")) {
    return {};
  }

  const end = md.indexOf("\n---", 3);

  if (end < 0) {
    return {};
  }

  const block = md.slice(3, end);
  const description = block
    .split("\n")
    .find((line) => line.startsWith("description:"))
    ?.replace("description:", "")
    .trim()
    .replace(/^['"]|['"]$/g, "");

  return { description };
}

export function discoverSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }

    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry, "SKILL.md");

      if (!existsSync(path) || seen.has(entry)) {
        continue;
      }

      seen.add(entry);

      const content = readFileSync(path, "utf-8");
      const { description } = parseFrontmatter(content);

      skills.push({
        name: entry,
        description: description ?? "(no description)",
        path,
      });
    }
  }

  return skills;
}
