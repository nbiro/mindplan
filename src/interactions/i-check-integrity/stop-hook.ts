/**
 * The Claude Code Stop hook — owned by i-check-integrity: a turn that changed files does not end on
 * a red check (`mindplan-mcp hook stop`, wired by the Claude Code plugin). It is the default check,
 * run only when the working tree changed (decision d-stop-hook-dirty-tree), with only its Blocked:
 * lines sent back.
 */

import * as fs from "fs";
import * as path from "path";
import { collectDirtySrcPaths } from "../../foundations/f-source-index/git.js";
import { isInUniverse } from "../../foundations/f-source-index/universe.js";
import { resolveProjectRoot } from "../../foundations/f-source-index/root-scope.js";
import { runIntegrityCheck } from "./check.js";

/** At most this many Blocked: entries go into the reason; the rest are counted. */
export const STOP_HOOK_MAX_FAILURES = 10;

export const STOP_HOOK_LEAD =
  "MindPlan check failed: fix these before you end the turn, or tell the user why you cannot.";

export interface StopHookOutput {
  decision: "block";
  reason: string;
}

/** True when the working tree has a changed path in the source universe or under mindplan/. */
function treeChanged(root: string): boolean {
  const { workingTree } = collectDirtySrcPaths(root);
  return workingTree.some((p) => p === "mindplan" || p.startsWith("mindplan/") || isInUniverse(p, root));
}

/**
 * The Stop answer for a hook payload: `{ decision: "block", reason }` when the turn changed files
 * and the default check fails, else null (also on a second stop, outside a graph, or on its own error).
 */
export function stopHookDecision(input: unknown): StopHookOutput | null {
  if (!input || typeof input !== "object") return null;
  if ((input as { stop_hook_active?: unknown }).stop_hook_active === true) return null;
  try {
    const root = resolveProjectRoot();
    if (!fs.existsSync(path.join(root, "mindplan"))) return null;
    if (!treeChanged(root)) return null;
    const result = runIntegrityCheck({ cwd: root });
    if (result.ok) return null;
    const shown = result.failures.slice(0, STOP_HOOK_MAX_FAILURES);
    const more = result.failures.length - shown.length;
    const lines = [STOP_HOOK_LEAD, ...shown, ...(more > 0 ? [`+${more} more (run mindplan-mcp check)`] : [])];
    return { decision: "block", reason: lines.join("\n") };
  } catch {
    return null;
  }
}
