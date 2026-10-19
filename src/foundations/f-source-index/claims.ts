/**
 * Claim path validation and directory expansion for `implements` entries.
 */

import * as fs from "fs";
import * as path from "path";
import { matchGlob } from "./universe.js";

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
    if (entry.name === ".git" || entry.name === "node_modules") continue;
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
 * True when a claim entry is a glob (`*`, `**`, or `?`). `[` and `]` stay literal so
 * route folders such as `[slug]` are plain paths.
 */
export function isGlobClaim(entry: string): boolean {
  return /[*?]/.test(entry);
}

/** The pattern a glob claim matches files against: a trailing `/` matches everything beneath. */
function globFilePattern(claim: string): string {
  return claim.endsWith("/") ? `${claim}**` : claim;
}

/**
 * Glob expansions for the current synchronous call. One check or status call expands the same
 * claims many times (ownership index, conflicts, blast radius); a glob walks the disk, so its
 * result is reused until the event loop turns. Tool calls and CLI runs are synchronous, so a
 * file written between calls is always seen.
 */
let globCache: Map<string, string[]> | null = null;

/** Files on disk matching a glob claim, walked from its static prefix. */
function expandGlobClaim(claim: string, cwd: string): string[] {
  const key = `${cwd}\0${claim}`;
  if (!globCache) {
    globCache = new Map();
    setImmediate(() => {
      globCache = null;
    });
  }
  const hit = globCache.get(key);
  if (hit) return hit;
  const segments = claim.split("/");
  const firstGlob = segments.findIndex((s) => isGlobClaim(s));
  const prefix = segments.slice(0, firstGlob).join("/");
  const relDir = prefix ? `${prefix}/` : "";
  const abs = prefix ? path.join(cwd, ...segments.slice(0, firstGlob)) : cwd;
  const pattern = globFilePattern(claim);
  const files = walkDirFiles(abs, relDir).filter((f) => matchGlob(pattern, f));
  globCache.set(key, files);
  return files;
}

/** True when a claim entry (file, directory ending in `/`, or glob) covers a repo-relative file path. */
export function claimCoversPath(claim: string, rel: string): boolean {
  const normalized = claim.trim().replace(/\\/g, "/");
  if (!normalized) return false;
  if (isGlobClaim(normalized)) return matchGlob(globFilePattern(normalized), rel);
  if (normalized.endsWith("/")) return rel.startsWith(normalized);
  return normalized === rel;
}

/**
 * Expand implements entries to exact file paths.
 * Directory claims end with `/` and expand to all non-.gitkeep files beneath.
 * Glob claims expand to the matching files (a trailing `/` matches every file beneath each
 * matching directory). Missing files/dirs are omitted from expansion (presence is checked separately).
 */
export function expandClaims(entries: string[] | undefined, root?: string): string[] {
  if (!entries || entries.length === 0) return [];
  const cwd = resolveProjectRoot(root);
  const files = new Set<string>();
  for (const entry of entries) {
    const claim = validateClaimPath(entry);
    if (isGlobClaim(claim)) {
      for (const f of expandGlobClaim(claim, cwd)) files.add(f);
    } else if (claim.endsWith("/")) {
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

/** True when a claim entry currently exists on disk (file, directory, or a glob matching a file). */
export function claimEntryExists(entry: string, root?: string): boolean {
  const claim = validateClaimPath(entry);
  const cwd = resolveProjectRoot(root);
  if (isGlobClaim(claim)) return expandGlobClaim(claim, cwd).length > 0;
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
