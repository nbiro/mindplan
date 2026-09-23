/**
 * Claim path validation and directory expansion for `implements` entries.
 */

import * as fs from "fs";
import * as path from "path";

function resolveProjectRoot(root?: string): string {
  return root ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

/**
 * Normalize and validate a single implements entry.
 * Rejects `..`, absolute paths, and anything under `mindplan/`.
 */
export function validateClaimPath(entry: string): string {
  const raw = entry.trim().replace(/\\/g, "/");
  if (!raw) {
    throw blocked("implements entry must be a non-empty repo-relative path.");
  }
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
    throw blocked(`implements path must be repo-relative (got "${entry}").`);
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === "..")) {
    throw blocked(`implements path must not contain ".." (got "${entry}").`);
  }
  // Collapse "." segments
  const cleaned = parts.filter((p) => p !== ".").join("/");
  if (!cleaned || cleaned === "/") {
    throw blocked(`implements path must be a non-empty repo-relative path (got "${entry}").`);
  }
  const normalized = cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
  if (normalized === "mindplan" || normalized.startsWith("mindplan/")) {
    throw blocked(`implements path must not claim territory under mindplan/ (got "${entry}").`);
  }
  return normalized;
}

function walkDirFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = `${relDir}${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDirFiles(abs, `${rel}/`));
    } else if (entry.isFile()) {
      if (entry.name === ".gitkeep") continue;
      out.push(toPosix(rel));
    }
  }
  return out;
}

/**
 * Expand implements entries to exact file paths.
 * Directory claims end with `/` and expand to all non-.gitkeep files beneath.
 * Missing files/dirs are omitted from expansion (presence is checked separately).
 */
export function expandClaims(entries: string[] | undefined, root?: string): string[] {
  if (!entries || entries.length === 0) return [];
  const cwd = resolveProjectRoot(root);
  const files = new Set<string>();
  for (const entry of entries) {
    const claim = validateClaimPath(entry);
    if (claim.endsWith("/")) {
      const abs = path.join(cwd, ...claim.slice(0, -1).split("/"));
      for (const f of walkDirFiles(abs, claim)) files.add(f);
    } else {
      const abs = path.join(cwd, ...claim.split("/"));
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        if (path.posix.basename(claim) !== ".gitkeep") files.add(claim);
      }
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

/** True when a claim entry currently exists on disk (file or directory). */
export function claimEntryExists(entry: string, root?: string): boolean {
  const claim = validateClaimPath(entry);
  const cwd = resolveProjectRoot(root);
  if (claim.endsWith("/")) {
    const abs = path.join(cwd, ...claim.slice(0, -1).split("/"));
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  }
  const abs = path.join(cwd, ...claim.split("/"));
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

/** Validate a list of claim paths; returns normalized entries. */
export function normalizeClaimList(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const n = validateClaimPath(entry);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
