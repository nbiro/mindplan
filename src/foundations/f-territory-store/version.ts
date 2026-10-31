/**
 * Project version stamp — mindplan/version.json records which package last set up or upgraded the
 * tree, its graph format, and the migration level it reached. stampGraph (f-graph-migrations) is
 * the only writer; graphStatus there compares it with the running server.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { readFileRetry, writeFileRetry } from "../f-source-index/io.js";

const MINDPLAN_DIR = "mindplan";
const PACKAGE_NAME = "mindplan-mcp";
export const VERSION_FILENAME = "version.json";

/** Repo-relative POSIX path of the stamp. */
export const VERSION_RELATIVE_PATH = path.posix.join(MINDPLAN_DIR, VERSION_FILENAME);

/** Reported when this package's package.json cannot be read. */
export const FALLBACK_PACKAGE_VERSION = "0.0.0";

export type ProjectVersion = {
  package: string;
  graph: number;
  /** Migration level the tree reached; 0 for a stamp written before levels existed. */
  migrations: number;
};

function stampPath(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR, VERSION_FILENAME);
}

/**
 * The directory holding this package's own package.json, found by walking up from this module, so
 * it works from dist/ in the repo and from a consumer's node_modules. Throws when there is none.
 */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf-8")) as { name?: unknown };
      if (parsed.name === PACKAGE_NAME) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no ${PACKAGE_NAME} package.json above ${fileURLToPath(import.meta.url)}`);
}

/** Reads `version` from this package's own package.json. Throws when it cannot be read. */
function readOwnPackageVersion(): string {
  const manifest = path.join(packageRoot(), "package.json");
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf-8")) as { version?: unknown };
  if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  throw new Error(`${manifest} has no version`);
}

let cachedPackageVersion: string | undefined;

/**
 * The running package version. Never throws: an unreadable package.json yields
 * FALLBACK_PACKAGE_VERSION and one stderr note.
 */
export function packageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  try {
    cachedPackageVersion = readOwnPackageVersion();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `MindPlan: could not read package.json version (${reason}); reporting ${FALLBACK_PACKAGE_VERSION}`
    );
    cachedPackageVersion = FALLBACK_PACKAGE_VERSION;
  }
  return cachedPackageVersion;
}

/**
 * Reads mindplan/version.json. Returns null when the file is missing and "invalid" when it
 * cannot be parsed or lacks a semver `package` and an integer `graph`. An absent or non-integer
 * `migrations` reads as 0 (stamps written by init).
 */
export function readProjectVersion(): ProjectVersion | null | "invalid" {
  const abs = stampPath();
  if (!fs.existsSync(abs)) return null;
  try {
    const raw = JSON.parse(readFileRetry(abs)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
    const obj = raw as Record<string, unknown>;
    if (typeof obj.package !== "string" || parseSemver(obj.package) === null) return "invalid";
    if (typeof obj.graph !== "number" || !Number.isInteger(obj.graph)) return "invalid";
    const migrations =
      typeof obj.migrations === "number" && Number.isInteger(obj.migrations) && obj.migrations >= 0 ? obj.migrations : 0;
    return { package: obj.package, graph: obj.graph, migrations };
  } catch {
    return "invalid";
  }
}

/** Writes mindplan/version.json. Returns the repo-relative path. */
export function writeProjectVersion(version: ProjectVersion): string {
  const abs = stampPath();
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeFileRetry(
    abs,
    JSON.stringify({ package: version.package, graph: version.graph, migrations: version.migrations }, null, 2) + "\n"
  );
  return VERSION_RELATIVE_PATH;
}

type Semver = { core: [number, number, number]; pre: string | null };

function parseSemver(value: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function comparePre(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * SemVer precedence of two versions: negative, zero, or positive. A pre-release sorts before its
 * release; build metadata is ignored. Unparseable input compares as equal (no signal).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}
