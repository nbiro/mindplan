/**
 * Static import lexer + path resolver (no runtime typescript dependency).
 */

import * as fs from "fs";
import * as path from "path";
import { isInUniverse } from "./universe.js";

function resolveProjectRoot(root?: string): string {
  return root ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

const IMPORT_FROM =
  /\b(?:import|export)(?:\s+type)?(?:[\s\w{},*]+|\s*\*\s*as\s+\w+|\s+\w+)?\s+from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract literal module specifiers from TS/JS/TSX source text. */
export function lexImports(source: string): string[] {
  const found = new Set<string>();
  // Strip block comments and line comments so strings inside them are ignored loosely.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const re of [IMPORT_FROM, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

type TsPaths = { baseUrl?: string; paths?: Record<string, string[]> };

function loadTsconfigPaths(root: string): TsPaths {
  const file = path.join(root, "tsconfig.json");
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf-8");
    // Strip trailing commas / comments lightly for common tsconfig shapes
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const json = JSON.parse(cleaned) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    return {
      baseUrl: json.compilerOptions?.baseUrl,
      paths: json.compilerOptions?.paths,
    };
  } catch {
    return {};
  }
}

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function tryFile(abs: string): string | null {
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  return null;
}

function resolveAsFileOrIndex(absNoExt: string): string | null {
  const direct = tryFile(absNoExt);
  if (direct) return direct;
  for (const ext of SOURCE_EXTS) {
    const hit = tryFile(absNoExt + ext);
    if (hit) return hit;
  }
  if (fs.existsSync(absNoExt) && fs.statSync(absNoExt).isDirectory()) {
    for (const ext of SOURCE_EXTS) {
      const hit = tryFile(path.join(absNoExt, `index${ext}`));
      if (hit) return hit;
    }
  }
  return null;
}

function applyPathAlias(
  specifier: string,
  root: string,
  ts: TsPaths
): string | null {
  if (!ts.paths) return null;
  for (const [pattern, targets] of Object.entries(ts.paths)) {
    const star = pattern.indexOf("*");
    if (star >= 0) {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      const mid = specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const target of targets) {
        const mapped = target.replace("*", mid);
        const base = ts.baseUrl ? path.join(root, ts.baseUrl, mapped) : path.join(root, mapped);
        const hit = resolveAsFileOrIndex(base);
        if (hit) return hit;
      }
    } else if (specifier === pattern) {
      for (const target of targets) {
        const base = ts.baseUrl ? path.join(root, ts.baseUrl, target) : path.join(root, target);
        const hit = resolveAsFileOrIndex(base);
        if (hit) return hit;
      }
    }
  }
  if (ts.baseUrl && (specifier.startsWith("@/") || !specifier.startsWith("."))) {
    // bare relative-to-baseUrl without paths match
    if (!specifier.includes(":") && !specifier.startsWith("@") && !specifier.startsWith(".")) {
      const base = path.join(root, ts.baseUrl, specifier);
      const hit = resolveAsFileOrIndex(base);
      if (hit) return hit;
    }
  }
  return null;
}

function isBarePackage(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("@/")) return false; // common alias, not npm
  return true;
}

/**
 * Resolve a module specifier from `fromFile` (repo-relative POSIX) to a
 * repo-relative universe path, or null when ignored / unresolved / out of universe.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  root?: string,
  tsPaths?: TsPaths
): string | null {
  if (!specifier || specifier.startsWith("node:")) return null;
  const cwd = resolveProjectRoot(root);
  const ts = tsPaths ?? loadTsconfigPaths(cwd);

  let abs: string | null = null;

  if (specifier.startsWith(".")) {
    const fromAbs = path.join(cwd, ...fromFile.split("/"));
    const fromDir = path.dirname(fromAbs);
    let candidate = path.normalize(path.join(fromDir, specifier));
    // NodeNext: import "./x.js" → x.ts / x.tsx
    if (/\.(js|jsx|mjs|cjs)$/.test(candidate)) {
      const noExt = candidate.replace(/\.(js|jsx|mjs|cjs)$/, "");
      abs = resolveAsFileOrIndex(noExt) ?? resolveAsFileOrIndex(candidate);
    } else {
      abs = resolveAsFileOrIndex(candidate);
    }
  } else if (!isBarePackage(specifier) || specifier.startsWith("@/")) {
    abs = applyPathAlias(specifier, cwd, ts);
  } else {
    // bare package — ignore
    return null;
  }

  if (!abs) return null;
  const rel = toPosix(path.relative(cwd, abs));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!isInUniverse(rel, cwd)) return null;
  return rel;
}

export type ResolvedImport = { from: string; to: string; specifier: string };

/** Lex + resolve all in-universe imports for a source file. */
export function listResolvedImports(
  fromFile: string,
  root?: string
): ResolvedImport[] {
  const cwd = resolveProjectRoot(root);
  const abs = path.join(cwd, ...fromFile.split("/"));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [];
  const source = fs.readFileSync(abs, "utf-8");
  const ts = loadTsconfigPaths(cwd);
  const out: ResolvedImport[] = [];
  for (const specifier of lexImports(source)) {
    const to = resolveImport(fromFile, specifier, cwd, ts);
    if (to) out.push({ from: fromFile, to, specifier });
  }
  return out;
}
