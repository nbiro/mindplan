/**
 * Project-level MindPlan config (`mindplan/config.json`).
 * Declares which repo paths form the ownership universe (`sources` / `exclude`).
 */

import * as fs from "fs";
import * as path from "path";

export const CONFIG_FILENAME = "config.json";
const MINDPLAN_DIR = "mindplan";

export type MindPlanProjectConfig = {
  sources: string[];
  exclude: string[];
};

const DEFAULT_CONFIG: MindPlanProjectConfig = {
  sources: ["src/**"],
  exclude: [],
};

function resolveProjectRoot(root?: string): string {
  return root ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}

export function projectConfigRelativePath(): string {
  return path.posix.join(MINDPLAN_DIR, CONFIG_FILENAME);
}

export function projectConfigPath(root?: string): string {
  return path.join(resolveProjectRoot(root), MINDPLAN_DIR, CONFIG_FILENAME);
}

function blockedConfig(detail: string): Error {
  return new Error(`Blocked: invalid ${projectConfigRelativePath()}: ${detail}`);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw blockedConfig(`"${field}" must be an array of strings.`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw blockedConfig(`"${field}" must contain only non-empty strings.`);
    }
    out.push(item.trim());
  }
  return out;
}

/**
 * Load config.
 * - Missing file → sources: ["src/**"], exclude: []
 * - Present with legacy `implementation_packages` → Blocked → mindplan-mcp init
 * - Invalid JSON / shape → throws Blocked
 */
export function loadProjectConfig(root?: string): MindPlanProjectConfig {
  const file = projectConfigPath(root);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, sources: [...DEFAULT_CONFIG.sources], exclude: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw blockedConfig(`could not parse JSON (${detail}). Fix or delete the file.`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw blockedConfig('expected a JSON object with "sources" and "exclude".');
  }

  const obj = raw as Record<string, unknown>;
  if ("implementation_packages" in obj) {
    throw new Error(
      `Blocked: ${projectConfigRelativePath()} still uses "implementation_packages". ` +
        `Run \`mindplan-mcp init\` to migrate to { sources, exclude }.`
    );
  }

  if (!("sources" in obj) || !("exclude" in obj)) {
    throw blockedConfig('expected a JSON object with "sources" and "exclude" arrays.');
  }

  return {
    sources: parseStringArray(obj.sources, "sources"),
    exclude: parseStringArray(obj.exclude, "exclude"),
  };
}

export type WriteProjectConfigResult = {
  written: boolean;
  path: string;
  config: MindPlanProjectConfig;
};

/**
 * Write mindplan/config.json as `{ sources, exclude }`.
 * - When `force` is false: create only if missing.
 * - When `force` is true: always overwrite.
 */
export function writeProjectConfig(
  config: MindPlanProjectConfig,
  options: { force?: boolean; root?: string } = {}
): WriteProjectConfigResult {
  const rel = projectConfigRelativePath();
  const abs = projectConfigPath(options.root);
  const next: MindPlanProjectConfig = {
    sources: [...config.sources],
    exclude: [...config.exclude],
  };
  const exists = fs.existsSync(abs);
  if (exists && !options.force) {
    return { written: false, path: rel, config: loadProjectConfig(options.root) };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { written: true, path: rel, config: next };
}
