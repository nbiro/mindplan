/**
 * Test-file import scope: a test of node A exercises A where it is wired in, so it may import A's
 * own files and the files of A's direct dependents (a node with a depends_on, exposes, or mounts
 * edge to A) without an edge of its own. The import rule (`scanFiles`) consults it before the
 * import matrix, so the check and the per-transition gates agree.
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { type OwnershipBuckets, testOwnersOf } from "../f-source-index/ownership.js";

const DEPENDENT_EDGES = ["depends_on", "exposes", "mounts"] as const;

/** True when `node` has a depends_on, exposes, or mounts edge to `targetId`, live or in its next view. */
function isDirectDependent(node: MindPlanNode, targetId: string): boolean {
  return DEPENDENT_EDGES.some(
    (type) => (node[type] ?? []).includes(targetId) || (node.next?.[type] ?? []).includes(targetId)
  );
}

/**
 * Whether `file`, a test file of some node A (A's `tests` covers it, see `testOwnersOf`), may
 * import a file owned by `toOwner`: `toOwner` is A or a direct dependent of A in `graph` (the view
 * being judged: live, or live plus a change's revisions).
 */
export function testImportAllowed(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  file: string,
  toOwner: MindPlanNode
): boolean {
  const owners = testOwnersOf(buckets, file);
  if (owners.length === 0) return false;
  const to = graph.nodes.find((n) => n.id === toOwner.id) ?? toOwner;
  return owners.some((a) => a === to.id || isDirectDependent(to, a));
}
