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
 * Merge base of HEAD with the default branch: `main` / `origin/main`, then `master` /
 * `origin/master`. When both the local and the remote branch resolve, the newer merge base wins,
 * so a local branch that was never pulled cannot move the base back and count already-merged
 * commits as this branch's. Null outside git or when none resolves. Shared by the dirty-src check,
 * the decision gate, and the strict merge gate so all measure "this branch" from the same commit.
 */
export function defaultBaseRef(cwd: string): string | null {
  for (const branch of ["main", "master"]) {
    const bases = [`origin/${branch}`, branch]
      .map((ref) => git(["merge-base", "HEAD", ref], cwd)?.trim())
      .filter((base): base is string => !!base);
    if (bases.length === 0) continue;
    const [first, second] = bases;
    if (!second || first === second) return first;
    // `--is-ancestor` exits 0 (git returns "") when the first commit is an ancestor of the second.
    return git(["merge-base", "--is-ancestor", first, second], cwd) !== null ? second : first;
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

/**
 * Git's view of one directory of the project (the plan tree): the tree id of `<dir>` in the commit
 * the status call ran against, and the paths under it that differ from that commit in the working
 * tree or the index (untracked included), all relative to the project root. `null` when the root
 * is not in a git work tree, git fails, or git ignores a folder under `dir` or a file ending in
 * `ignoredExt` (any case): git cannot vouch for an ignored file. `tree` is null when there is no
 * such tree yet (no commit, or the directory is untracked).
 */
export type DirGitState = {
  tree: string | null;
  dirty: Set<string>;
};

const showPrefix = new Map<string, string | null>();

/** The project root's path below the repository top (`git rev-parse --show-prefix`), cached per root. */
export function repoPrefix(cwd: string): string | null {
  if (!showPrefix.has(cwd)) {
    const out = git(["rev-parse", "--is-inside-work-tree", "--show-prefix"], cwd);
    const lines = out?.split(/\r?\n/) ?? [];
    showPrefix.set(cwd, lines[0]?.trim() === "true" ? (lines[1] ?? "").trim() : null);
  }
  return showPrefix.get(cwd) ?? null;
}

/** The repository top for the project root (`git rev-parse --show-toplevel`); null outside git. */
export function repoTop(root?: string): string | null {
  return git(["rev-parse", "--show-toplevel"], resolveProjectRoot(root))?.trim() || null;
}

/** The rest of a record after its first `n` space-separated fields (porcelain v2 puts the path last). */
function afterFields(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    at = record.indexOf(" ", at) + 1;
    if (at === 0) return "";
  }
  return record.slice(at);
}

/** Fields before the path in each porcelain v2 record type (`--no-renames` rules out type `2`). */
const V2_PATH_FIELD: Record<string, number> = { "1": 8, u: 10, "?": 1, "!": 1 };

export function dirGitState(dir: string, ignoredExt: string, root?: string): DirGitState | null {
  const cwd = resolveProjectRoot(root);
  const prefix = repoPrefix(cwd);
  if (prefix === null) return null;
  // One call reports both the status and the commit it was taken against (`# branch.oid`), so a
  // commit landing between two calls cannot pair an old status with a new tree.
  const status = git(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames", "--", dir],
    cwd
  );
  if (status === null) return null;
  const dirty = new Set<string>();
  let commit: string | null = null;
  const ext = ignoredExt.toLowerCase();
  for (const record of paths(status)) {
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      commit = /^[0-9a-f]+$/.test(oid) ? oid : null;
      continue;
    }
    const fields = V2_PATH_FIELD[record[0]];
    if (fields === undefined) continue;
    // Porcelain paths are relative to the repository top; the plan's paths to the project root.
    let rel = afterFields(record, fields);
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (record[0] === "!") {
      if (rel.toLowerCase().endsWith(ext) || rel.endsWith("/")) return null;
      continue;
    }
    dirty.add(rel);
  }
  // `<commit>:<path>^{tree}` would read `^{tree}` as part of the path; ls-tree names the object type.
  const entry = commit ? (git(["ls-tree", "--full-tree", "-z", commit, "--", `${prefix}${dir}`], cwd) ?? "") : "";
  const match = /^040000 tree ([0-9a-f]+)\t/.exec(entry);
  return { tree: match ? match[1] : null, dirty };
}

/**
 * Paths (relative to `dir`) that differ between two trees of `dir`; null when git fails. Uses the
 * plumbing `diff-tree`, which ignores porcelain settings such as `diff.relative`.
 */
export function treeChanges(fromTree: string, toTree: string, root?: string): Set<string> | null {
  if (fromTree === toTree) return new Set();
  const out = git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", fromTree, toTree], resolveProjectRoot(root));
  return out === null ? null : new Set(paths(out));
}

/** True when a repo-relative path is a migration or schema file under `globs`. */
export function matchesSchemaFile(filePath: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(g, filePath));
}
