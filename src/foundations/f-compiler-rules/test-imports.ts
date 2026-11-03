/**
 * Test-file import scope: a test of node A exercises A where it is wired in, so it may import A's
 * own files and the files of A's direct dependents (a node with a depends_on, exposes, or mounts
 * edge to A) without an edge of its own. Only a file A's `tests` covers that also looks like a
 * test (`*.test.*`, `*.spec.*`, or under a `__tests__`, `test`, or `tests` folder) counts: a
 * production file in a folder `tests` lists gains nothing. The import rule (`scanFiles`) consults
 * it before the import matrix, so the check and the per-transition gates agree.
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { type OwnershipBuckets, testOwnersOf } from "../f-source-index/ownership.js";

const DEPENDENT_EDGES = new Set<string>(["depends_on", "exposes", "mounts"]);
const TEST_SEGMENTS = new Set(["__tests__", "test", "tests"]);

/** True when a repo-relative path looks like a test file by its name or a folder on its path. */
export function looksLikeTestFile(file: string): boolean {
  const segments = file.split("/");
  const name = segments[segments.length - 1];
  if (/\.(test|spec)\.[^/]+$/.test(name)) return true;
  return segments.slice(0, -1).some((s) => TEST_SEGMENTS.has(s));
}

/**
 * True when `nodeId` has a depends_on, exposes, or mounts edge to `targetId` in `graph`'s edges:
 * live edges, plus the judged change's revisions when `graph` is that change's view (`graphUnder`).
 * Other changes' revisions do not count.
 */
function isDirectDependent(graph: MindPlanGraph, nodeId: string, targetId: string): boolean {
  return dependentEdgeKeys(graph).has(`${nodeId}\0${targetId}`);
}

/** Per graph: its `edges` array (and length) and the `source\0target` key of each dependent edge in it. */
const dependentKeysByGraph = new WeakMap<MindPlanGraph, { edges: MindPlanGraph["edges"]; length: number; keys: Set<string> }>();

/** The `source\0target` keys of `graph`'s dependent edges, built once per graph (again when `edges` is replaced or grows). */
function dependentEdgeKeys(graph: MindPlanGraph): Set<string> {
  const cached = dependentKeysByGraph.get(graph);
  if (cached && cached.edges === graph.edges && cached.length === graph.edges.length) return cached.keys;
  const keys = new Set<string>();
  for (const e of graph.edges) if (DEPENDENT_EDGES.has(e.type)) keys.add(`${e.source}\0${e.target}`);
  dependentKeysByGraph.set(graph, { edges: graph.edges, length: graph.edges.length, keys });
  return keys;
}

/**
 * Whether `file`, a test file of some node A (A's `tests` covers it, see `testOwnersOf`, and it
 * looks like a test), may import a file owned by `toOwner`: `toOwner` is A or a direct dependent
 * of A in `graph` (the view being judged: live, or live plus one change's revisions).
 */
export function testImportAllowed(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  file: string,
  toOwner: MindPlanNode
): boolean {
  if (!looksLikeTestFile(file)) return false;
  const owners = testOwnersOf(buckets, file);
  if (owners.length === 0) return false;
  return owners.some((a) => a === toOwner.id || isDirectDependent(graph, toOwner.id, a));
}
