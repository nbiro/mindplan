/**
 * Project-level MindPlan config (`mindplan/config.json`).
 * Declares which repo paths form the ownership universe (`sources` / `exclude`), and optionally
 * when the decision gate asks for a decision (`decisions`) and how search ranks (`search`).
 */

import * as fs from "fs";
import * as path from "path";

export const CONFIG_FILENAME = "config.json";
const MINDPLAN_DIR = "mindplan";

/** When a revision is decision-worthy: more dependents than `blast_radius`, or a new `schema_files` match. */
export type DecisionGateSettings = {
  blast_radius: number;
  schema_files: string[];
};

/** Search settings: `enabled: false` turns semantic ranking off; `model` names the embedding model. */
export type SearchConfigSettings = {
  enabled: boolean;
  model: string;
};

export type MindPlanProjectConfig = {
  sources: string[];
  exclude: string[];
  /** Stored decision-gate settings; absent fields take `DEFAULT_DECISION_SETTINGS`. */
  decisions?: Partial<DecisionGateSettings>;
  /** Stored search settings; absent fields take the search index's defaults. */
  search?: Partial<SearchConfigSettings>;
};

/**
 * Database migrations and schema dumps only: a generic `schema.*` also matches JSON Schema, zod,
 * and GraphQL modules, which would gate changes with no database impact. Projects widen the list
 * in config.
 */
export const DEFAULT_DECISION_SETTINGS: DecisionGateSettings = {
  blast_radius: 5,
  schema_files: [
    "**/migrations/**",
    "**/migration/**",
    "**/*.prisma",
    "**/schema.sql",
    "**/structure.sql",
    "**/db/schema.rb",
  ],
};

/** The decision-gate settings in effect: stored values over the defaults. */
export function decisionGateSettings(config: MindPlanProjectConfig): DecisionGateSettings {
  return {
    blast_radius: config.decisions?.blast_radius ?? DEFAULT_DECISION_SETTINGS.blast_radius,
    schema_files: [...(config.decisions?.schema_files ?? DEFAULT_DECISION_SETTINGS.schema_files)],
  };
}

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

/** Validates the optional `decisions` object; unknown keys are Blocked so a typo cannot silently use a default. */
function parseDecisionSettings(value: unknown): Partial<DecisionGateSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blockedConfig('"decisions" must be an object with optional "blast_radius" and "schema_files".');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "blast_radius" && key !== "schema_files") {
      throw blockedConfig(`"decisions" has unknown key "${key}" (allowed: blast_radius, schema_files).`);
    }
  }
  const out: Partial<DecisionGateSettings> = {};
  if (obj.blast_radius !== undefined) {
    const n = obj.blast_radius;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw blockedConfig('"decisions.blast_radius" must be a non-negative integer.');
    }
    out.blast_radius = n;
  }
  if (obj.schema_files !== undefined) {
    out.schema_files = parseStringArray(obj.schema_files, "decisions.schema_files");
  }
  return out;
}

/** Validates the optional `search` object; unknown keys are Blocked like `decisions`. */
function parseSearchSettings(value: unknown): Partial<SearchConfigSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blockedConfig('"search" must be an object with optional "enabled" and "model".');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "enabled" && key !== "model") {
      throw blockedConfig(`"search" has unknown key "${key}" (allowed: enabled, model).`);
    }
  }
  const out: Partial<SearchConfigSettings> = {};
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") throw blockedConfig('"search.enabled" must be true or false.');
    out.enabled = obj.enabled;
  }
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || !obj.model.trim()) {
      throw blockedConfig('"search.model" must be a non-empty model id, e.g. "Xenova/bge-small-en-v1.5".');
    }
    out.model = obj.model.trim();
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

  const config: MindPlanProjectConfig = {
    sources: parseStringArray(obj.sources, "sources"),
    exclude: parseStringArray(obj.exclude, "exclude"),
  };
  if ("decisions" in obj) config.decisions = parseDecisionSettings(obj.decisions);
  if ("search" in obj) config.search = parseSearchSettings(obj.search);
  return config;
}

export type WriteProjectConfigResult = {
  written: boolean;
  path: string;
  config: MindPlanProjectConfig;
};

/**
 * Write mindplan/config.json as `{ sources, exclude }`, plus `decisions` and `search` when the
 * config has them.
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
  if (config.decisions) {
    const decisions = parseDecisionSettings(config.decisions);
    if (Object.keys(decisions).length > 0) next.decisions = decisions;
  }
  if (config.search) {
    const search = parseSearchSettings(config.search);
    if (Object.keys(search).length > 0) next.search = search;
  }
  const exists = fs.existsSync(abs);
  if (exists && !options.force) {
    return { written: false, path: rel, config: loadProjectConfig(options.root) };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { written: true, path: rel, config: next };
}
