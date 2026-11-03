/**
 * The project root a tool call works on. One MCP server can serve several checkouts of the same
 * repository (the main tree and its git worktrees): a call names its checkout with `root`, and
 * everything that resolves a path under mindplan/ (the store, the source index, the version stamp)
 * reads it from this scope. The scope follows the call through awaits (AsyncLocalStorage), so two
 * interleaved calls on different roots never see each other's root. Outside a scope the root is
 * MINDPLAN_ROOT, else the process cwd. The scope also holds what one call collects as it runs
 * (the legacy territory files its graph loads removed), so interleaved calls never mix those either.
 */
import { AsyncLocalStorage } from "async_hooks";
import * as path from "path";

/** A root's folder of derived caches (graph cache, search index, acks): git-ignored, safe to delete. */
export const CACHE_DIRNAME = ".mindplan-cache";

/** A legacy territory file a graph load deleted because its id-named twin was kept (repo-relative). */
export type RemovedLegacyFile = { from: string; to: string };

/** One call's scope: its root (undefined: the server's) and the legacy files its loads removed. */
type CallScope = { root: string | undefined; removedLegacyFiles: RemovedLegacyFile[] };

const scope = new AsyncLocalStorage<CallScope>();

/**
 * Runs fn in a fresh call scope: `root` as the project root for everything it (and what it awaits)
 * resolves (undefined keeps the enclosing scope's root, else the server's), and an empty list of
 * removed legacy files.
 */
export function withRoot<T>(root: string | undefined, fn: () => T): T {
  const scoped = root === undefined ? currentRoot() : path.resolve(root);
  return scope.run({ root: scoped, removedLegacyFiles: [] }, fn);
}

/** The root set by the innermost withRoot, or undefined outside any scope (or in one with no root). */
export function currentRoot(): string | undefined {
  return scope.getStore()?.root;
}

/** The scoped root when it is another than the server's own (MINDPLAN_ROOT, else cwd), else undefined. */
export function foreignRoot(): string | undefined {
  const root = currentRoot();
  if (root === undefined) return undefined;
  return rootKey(root) === rootKey(process.env.MINDPLAN_ROOT ?? process.cwd()) ? undefined : root;
}

/** The innermost call scope's list of removed legacy files (the caller's to push to and drain), or undefined outside any scope. */
export function scopedRemovedLegacyFiles(): RemovedLegacyFile[] | undefined {
  return scope.getStore()?.removedLegacyFiles;
}

/**
 * The key a per-root map uses for `root`: resolved, and lowercased on Windows, whose paths are
 * case-insensitive (one checkout named with two casings is one root).
 */
export function rootKey(root: string): string {
  const abs = path.resolve(root);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** The project root: an explicit root, else the scoped root, else MINDPLAN_ROOT, else cwd. */
export function resolveProjectRoot(root?: string): string {
  return root ?? currentRoot() ?? process.env.MINDPLAN_ROOT ?? process.cwd();
}
