/**
 * Project brief — description and standing rules for the consumer repo.
 * Storage seam: today reads mindplan/project.md; callers must not assume a file path.
 */

import * as fs from "fs";
import * as path from "path";

const MINDPLAN_DIR = "mindplan";
export const PROJECT_FILENAME = "project.md";

/** Repo-relative POSIX path used while territory is local. */
export const PROJECT_RELATIVE_PATH = path.posix.join(MINDPLAN_DIR, PROJECT_FILENAME);

/** Empty brief injected when storage is missing or unreadable. Always present in MCP instructions. */
export const EMPTY_PROJECT_BRIEF_MARKDOWN = `# Project

## Description


## Rules

`;

export type ProjectBrief = {
  /** Local path today; may be null once storage is remote. */
  path: string | null;
  description: string;
  rules: string;
  /** Full markdown for MCP instructions injection (never empty of structure). */
  markdown: string;
};

function mindplanRoot(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR);
}

function parseSections(raw: string): { description: string; rules: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  return {
    description: sectionBody(normalized, "Description"),
    rules: sectionBody(normalized, "Rules"),
  };
}

function sectionBody(markdown: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |\\z)`, "m");
  const match = markdown.match(re);
  return (match?.[1] ?? "").trim();
}

/**
 * Load the project brief from territory storage.
 * Missing or unreadable storage returns empty description/rules and the empty template markdown.
 * Never throws.
 */
export function loadProjectBrief(): ProjectBrief {
  const abs = path.join(mindplanRoot(), PROJECT_FILENAME);
  try {
    if (!fs.existsSync(abs)) {
      return {
        path: PROJECT_RELATIVE_PATH,
        description: "",
        rules: "",
        markdown: EMPTY_PROJECT_BRIEF_MARKDOWN,
      };
    }
    const raw = fs.readFileSync(abs, "utf-8");
    const { description, rules } = parseSections(raw);
    const trimmed = raw.replace(/^\uFEFF/, "").replace(/\s+$/, "") + "\n";
    return {
      path: PROJECT_RELATIVE_PATH,
      description,
      rules,
      markdown: trimmed.length > 1 ? trimmed : EMPTY_PROJECT_BRIEF_MARKDOWN,
    };
  } catch {
    return {
      path: PROJECT_RELATIVE_PATH,
      description: "",
      rules: "",
      markdown: EMPTY_PROJECT_BRIEF_MARKDOWN,
    };
  }
}
