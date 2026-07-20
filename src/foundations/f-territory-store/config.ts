/**
 * Project-level MindPlan config (`mindplan/config.json`).
 * Controls whether prescribed implementation packages are required.
 */

import * as fs from "fs";
import * as path from "path";

export const CONFIG_FILENAME = "config.json";
const MINDPLAN_DIR = "mindplan";

export type ImplementationPackagesMode = "required" | "off";

export type MindPlanProjectConfig = {
  implementation_packages: ImplementationPackagesMode;
};

const DEFAULT_CONFIG: MindPlanProjectConfig = {
  implementation_packages: "required",
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

function parseMode(value: unknown): ImplementationPackagesMode | null {
  if (value === "required" || value === "off") return value;
  return null;
}

function blockedConfig(detail: string): Error {
  return new Error(`Blocked: invalid ${projectConfigRelativePath()}: ${detail}`);
}

/**
 * Load config.
 * - Missing file → implementation_packages: "required"
 * - Present but invalid JSON / shape / mode → throws Blocked (hard fail)
 */
export function loadProjectConfig(root?: string): MindPlanProjectConfig {
  const file = projectConfigPath(root);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw blockedConfig(`could not parse JSON (${detail}). Fix or delete the file.`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw blockedConfig('expected a JSON object with "implementation_packages".');
  }

  const mode = parseMode((raw as Record<string, unknown>).implementation_packages);
  if (!mode) {
    throw blockedConfig(
      `"implementation_packages" must be "required" or "off" (got ${JSON.stringify(
        (raw as Record<string, unknown>).implementation_packages
      )}).`
    );
  }

  return { implementation_packages: mode };
}

export function implementationPackagesRequired(root?: string): boolean {
  return loadProjectConfig(root).implementation_packages === "required";
}

export type WriteProjectConfigResult = {
  written: boolean;
  path: string;
  config: MindPlanProjectConfig;
};

/**
 * Write mindplan/config.json.
 * - When `force` is false: create only if missing (default mode).
 * - When `force` is true: always write the given mode (explicit --layout).
 * Reading an existing invalid config (force false) still hard-fails via loadProjectConfig.
 */
export function writeProjectConfig(
  mode: ImplementationPackagesMode,
  options: { force?: boolean; root?: string } = {}
): WriteProjectConfigResult {
  const rel = projectConfigRelativePath();
  const abs = projectConfigPath(options.root);
  const config: MindPlanProjectConfig = { implementation_packages: mode };
  const exists = fs.existsSync(abs);
  if (exists && !options.force) {
    return { written: false, path: rel, config: loadProjectConfig(options.root) };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return { written: true, path: rel, config };
}
