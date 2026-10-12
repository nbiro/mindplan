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
  const start = markdown.match(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (!start || start.index === undefined) return "";
  const afterHeading = markdown.slice(start.index + start[0].length).replace(/^\n/, "");
  const next = afterHeading.search(/^## /m);
  return (next === -1 ? afterHeading : afterHeading.slice(0, next)).trim();
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

function renderBrief(description: string, rules: string): string {
  const d = description.trim();
  const r = rules.trim();
  return `# Project\n\n## Description\n\n${d ? `${d}\n` : ""}\n## Rules\n\n${r ? `${r}\n` : ""}`;
}

/**
 * Write mindplan/project.md description and/or rules sections.
 * Omitted fields keep their current values. Creates the file when missing.
 */
export function writeProjectBrief(input: {
  description?: string;
  rules?: string;
}): ProjectBrief {
  const current = loadProjectBrief();
  const description =
    input.description !== undefined ? input.description : current.description;
  const rules = input.rules !== undefined ? input.rules : current.rules;
  const markdown = renderBrief(description, rules);
  const abs = path.join(mindplanRoot(), PROJECT_FILENAME);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown, "utf-8");
  return {
    path: PROJECT_RELATIVE_PATH,
    description: description.trim(),
    rules: rules.trim(),
    markdown,
  };
}
