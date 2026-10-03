import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  meta: Record<string, string>;
}

export interface GmPrompts {
  /** The system prompt body, identical for every user (the global cache block). */
  system: string;
  skills: Map<string, Skill>;
  /** GM_PROMPT_VERSION: the system prompt's version plus a hash of every prompt file. */
  version: string;
}

export interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

/** Parses the `---` block of simple `key: value` lines at the top of a prompt file. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv?.[1]) continue;
    meta[kv[1]] = (kv[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/** Walks up from `start` to the first folder holding `agents/gm/system.md`. */
export function findPromptDir(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "agents", "gm");
    if (existsSync(join(candidate, "system.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No agents/gm/system.md above ${start}`);
    dir = parent;
  }
}

/** Loads `system.md` and `skills/*.md` once at boot. */
export async function loadGmPrompts(dir = findPromptDir()): Promise<GmPrompts> {
  const hash = createHash("sha256");
  const systemText = await readFile(join(dir, "system.md"), "utf8");
  hash.update(systemText);
  const system = parseFrontmatter(systemText);

  const skills = new Map<string, Skill>();
  const files = (await readdir(join(dir, "skills"))).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const text = await readFile(join(dir, "skills", file), "utf8");
    hash.update(file).update(text);
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name ?? file.replace(/\.md$/, "");
    skills.set(name, { name, description: meta.description ?? "", body, meta });
  }

  return {
    system: system.body,
    skills,
    version: `gm-${system.meta.version ?? "0"}+${hash.digest("hex").slice(0, 8)}`,
  };
}

const DEFAULT_GREETING =
  "Hi {first_name}, I'm your GM. Tell me what you want and I'll find a trade for it in your Circles.";

/** The intake opener from `skills/intake.md` (`greeting:`), with the first name filled in. */
export function greetingFor(prompts: GmPrompts, firstName: string | null): string {
  const template = prompts.skills.get("intake")?.meta.greeting || DEFAULT_GREETING;
  return firstName
    ? template.replaceAll("{first_name}", firstName)
    : template.replace(/ \{first_name\}/g, "").replaceAll("{first_name}", "");
}
