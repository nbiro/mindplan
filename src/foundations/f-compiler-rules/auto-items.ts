/**
 * Default checklist items the server closes itself, so agents tick only what they added. Owned by
 * f-compiler-rules.
 *
 * - `spec` and `impl` (every pipeline node's default Atomic Ops) count as done at ship: shipping
 *   is the claim that the spec was written and the implementation is complete.
 * - `verify` counts as done once the node's linked tests passed in this session's last
 *   `run_check({ run_tests: true })` that ran them.
 * - Every other item, and every `review` / `deploy` item, is ticked by hand.
 *
 * Test results live in memory for this server process (one session), keyed by project root.
 */

import type { ChecklistItem } from "../f-territory-store/checklist.js";
import { parseChecklistItems } from "../f-territory-store/checklist.js";
import { resolveProjectRoot, rootKey } from "../f-source-index/root-scope.js";

/** The default item ids ship closes on its own. */
export const SHIP_CLOSES = ["spec", "impl"] as const;

/** The default item id a passing test run closes. */
export const TESTS_CLOSE = "verify";

/** Per project root + node id: whether its linked tests passed in the last run that ran them. */
const results = new Map<string, { passed: boolean; at: string }>();

const key = (nodeId: string) => `${rootKey(resolveProjectRoot())}\u0000${nodeId}`;

/** Record a test run over these nodes' linked tests. */
export function recordTestRun(nodeIds: string[], passed: boolean, at: string = new Date().toISOString()): void {
  for (const id of nodeIds) results.set(key(id), { passed, at });
}

/** Whether `nodeId`'s linked tests passed in the last run that ran them in this session. */
export function testsPassed(nodeId: string): boolean {
  return results.get(key(nodeId))?.passed === true;
}

/** Forget every recorded run (tests). */
export function resetTestRuns(): void {
  results.clear();
}

/** Whether the server closes this unticked item for `nodeId` (a build item only). */
export function closedByServer(item: ChecklistItem, nodeId: string): boolean {
  if (item.kind !== "build" || item.done || !item.id) return false;
  if ((SHIP_CLOSES as readonly string[]).includes(item.id)) return true;
  return item.id === TESTS_CLOSE && testsPassed(nodeId);
}

/** The unticked items of a text the server closes for `nodeId`. */
export function serverClosedItems(text: string, nodeId: string): ChecklistItem[] {
  return parseChecklistItems(text).filter((i) => !i.checked && closedByServer(i, nodeId));
}
