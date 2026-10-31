/**
 * Served skills — owned by i-read-brief: get_skill lists and returns the skills bundled under
 * templates/agent/skills/<name>/, so an agent always reads the guidance of the server it talks to
 * (decision d-skills-served-by-server).
 */

import * as fs from "fs";
import * as path from "path";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import { findPackageFile } from "./spec.js";

const SKILL_FILE = "SKILL.md";

function skillsRoot(): string {
  const dir = findPackageFile("templates", "agent", "skills");
  if (!dir) {
    throw blocked("get_skill could not find templates/agent/skills. Reinstall mindplan-mcp so the skills ship with the package.");
  }
  return dir;
}

function skillNames(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, SKILL_FILE)))
    .map((e) => e.name)
    .sort();
}

/** Supporting files of a skill (every file but SKILL.md), as POSIX paths relative to its folder. */
function supportingFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...supportingFiles(dir, childRel));
    else if (entry.isFile() && childRel !== SKILL_FILE) out.push(childRel);
  }
  return out.sort();
}

/** Splits a leading `---` frontmatter block from the text; returns the body and its description. */
function splitFrontmatter(raw: string): { body: string; description: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { body: text, description: "" };
  const fm = m[1];
  // `description: >-` folds the indented lines below it into one line.
  const folded = /^description:\s*>-?\s*\n((?:[ \t]+.*\n?)+)/m.exec(fm);
  const inline = /^description:\s*(?!>)(.+)$/m.exec(fm);
  const description = folded
    ? folded[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ")
    : (inline?.[1].trim().replace(/^["']|["']$/g, "") ?? "");
  return { body: text.slice(m[0].length).replace(/^\n+/, ""), description };
}

/**
 * get_skill: without name, the list of skills; with name, the skill's text and supporting files;
 * with file, one supporting file. Unknown names and files are Blocked with the valid ones.
 */
export function getSkill(args: { name?: string; file?: string } = {}): Record<string, unknown> {
  const root = skillsRoot();
  const names = skillNames(root);
  if (args.name === undefined) {
    if (args.file !== undefined) throw blocked("get_skill: file needs name (the skill it belongs to).");
    return {
      skills: names.map((name) => {
        const dir = path.join(root, name);
        return {
          name,
          description: splitFrontmatter(fs.readFileSync(path.join(dir, SKILL_FILE), "utf-8")).description,
          files: supportingFiles(dir),
        };
      }),
    };
  }
  if (!names.includes(args.name)) {
    throw blocked(`get_skill: no skill "${args.name}". Skills: ${names.join(", ")}.`);
  }
  const dir = path.join(root, args.name);
  const files = supportingFiles(dir);
  if (args.file !== undefined) {
    const file = args.file.replace(/\\/g, "/");
    if (!files.includes(file)) {
      throw blocked(
        `get_skill: skill "${args.name}" has no file "${args.file}". Files: ${files.length > 0 ? files.join(", ") : "(none)"}.`
      );
    }
    return { name: args.name, file, text: fs.readFileSync(path.join(dir, ...file.split("/")), "utf-8").replace(/\r\n/g, "\n") };
  }
  const { body } = splitFrontmatter(fs.readFileSync(path.join(dir, SKILL_FILE), "utf-8"));
  return { name: args.name, text: body, files };
}
