/**
 * File universe — git-visible (or walked) paths matching sources minus exclude.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { loadProjectConfig, type MindPlanProjectConfig } from "./config.js";

function resolveProjectRoot(root?: string): string {
  return root ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Minimal glob match for `*`, `**`, and `?` (POSIX path segments). */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normPattern = pattern.replace(/\\/g, "/");
  const normPath = filePath.replace(/\\/g, "/");
  const re = globToRegExp(normPattern);
  return re.test(normPath);
}

function globToRegExp(pattern: string): RegExp {
  let i = 0;
  let out = "^";
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if ("+.^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
    i++;
  }
  out += "$";
  return new RegExp(out);
}

function matchesAny(globs: string[], filePath: string): boolean {
  return globs.some((g) => matchGlob(g, filePath));
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function collectGitVisibleFiles(cwd: string): string[] | null {
  const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside !== "true") return null;

  const tracked = git(["ls-files", "-z"], cwd);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], cwd);
  const paths = new Set<string>();
  for (const blob of [tracked, untracked]) {
    if (!blob) continue;
    for (const entry of blob.split("\0")) {
      if (!entry) continue;
      paths.add(toPosix(entry));
    }
  }
  return [...paths];
}

function walkFiles(absDir: string, relBase = ""): string[] {
  const out: string[] = [];
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(toPosix(rel));
    }
  }
  return out;
}

function filterUniverse(files: string[], config: MindPlanProjectConfig): string[] {
  const sources = config.sources;
  const exclude = config.exclude;
  // Empty sources → empty universe (brownfield / layout-free migration).
  if (sources.length === 0) return [];
  return files
    .filter((p) => path.posix.basename(p) !== ".gitkeep")
    .filter((p) => matchesAny(sources, p))
    .filter((p) => !matchesAny(exclude, p))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Repo-relative POSIX paths in the ownership universe.
 * Prefers git-visible files; falls back to a directory walk.
 */
export function listUniverseFiles(root?: string): string[] {
  const cwd = resolveProjectRoot(root);
  const config = loadProjectConfig(cwd);
  const fromGit = collectGitVisibleFiles(cwd);
  const all = fromGit ?? walkFiles(cwd);
  return filterUniverse(all, config);
}

/** True when a repo-relative path is inside the configured universe. */
export function isInUniverse(relPosix: string, root?: string): boolean {
  const config = loadProjectConfig(root);
  if (config.sources.length === 0) return false;
  if (path.posix.basename(relPosix) === ".gitkeep") return false;
  if (!matchesAny(config.sources, relPosix)) return false;
  if (matchesAny(config.exclude, relPosix)) return false;
  return true;
}
