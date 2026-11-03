/**
 * The project root a tool call works on. One MCP server can serve several checkouts of the same
 * repository (the main tree and its git worktrees): a call names its checkout with `root`, and
 * everything that resolves a path under mindplan/ (the store, the source index, the version stamp)
 * reads it from this scope. The scope follows the call through awaits (AsyncLocalStorage), so two
 * interleaved calls on different roots never see each other's root. Outside a scope the root is
 * MINDPLAN_ROOT, else the process cwd.
 */
import { AsyncLocalStorage } from "async_hooks";
import * as path from "path";

const scope = new AsyncLocalStorage<string>();

/** Runs fn with root as the project root for everything it (and what it awaits) resolves. */
export function withRoot<T>(root: string | undefined, fn: () => T): T {
  if (root === undefined) return fn();
  return scope.run(path.resolve(root), fn);
}

/** The root set by the innermost withRoot, or undefined outside any scope. */
export function currentRoot(): string | undefined {
  return scope.getStore();
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
