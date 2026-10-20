/**
 * Read-only git probes over the project root, and the migration/schema file matcher used by the
 * decision gate. Paths are POSIX and relative to the project root.
 */

import { execFileSync } from "child_process";
import { matchGlob } from "./universe.js";

function resolveProjectRoot(root?: string): string {
  return root ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** Paths from `-z` output: NUL-separated and never C-quoted, so non-ASCII names stay intact. */
function paths(output: string | null): string[] {
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}

/**
 * Merge base of HEAD with the default branch: `main`, `origin/main`, `master`, then
 * `origin/master`. Null outside git or when none resolves. Shared by the dirty-src check and the
 * decision gate so both measure "this branch" from the same commit.
 */
export function defaultBaseRef(cwd: string): string | null {
  for (const branch of ["main", "master"]) {
    for (const ref of [branch, `origin/${branch}`]) {
      const base = git(["merge-base", "HEAD", ref], cwd)?.trim();
      if (base) return base;
    }
  }
  return null;
}

/**
 * Files the current branch adds: untracked files, staged additions, and files added
 * (`--diff-filter=A`) since the merge base of HEAD with the default branch (`defaultBaseRef`).
 * With no base, only untracked and staged additions. A file that already existed and was only
 * modified is not new. `null` when the root is not inside a git work tree.
 */
export function newFilesSinceBase(root?: string): Set<string> | null {
  const cwd = resolveProjectRoot(root);
  if (git(["rev-parse", "--is-inside-work-tree"], cwd)?.trim() !== "true") return null;
  const files = new Set<string>();
  // ls-files and --relative both report paths relative to cwd, so a project root below the
  // repository top still gets project-relative paths.
  for (const f of paths(git(["ls-files", "-z", "--others", "--exclude-standard"], cwd))) files.add(f);
  for (const f of paths(git(["diff", "-z", "--cached", "--name-only", "--diff-filter=A", "--relative"], cwd))) {
    files.add(f);
  }
  const base = defaultBaseRef(cwd);
  if (base) {
    for (const f of paths(git(["diff", "-z", "--name-only", "--diff-filter=A", "--relative", `${base}...HEAD`], cwd))) {
      files.add(f);
    }
  }
  return files;
}

/** True when a repo-relative path is a migration or schema file under `globs`. */
export function matchesSchemaFile(filePath: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(g, filePath));
}
