/**
 * Revision model — the pure rules every reader and writer of a shipped node's open revisions
 * shares: edge, claim, and test deltas against live, which revision a call means, and the
 * live-plus-one-revision view gates read. No module-level state, no file I/O.
 */

import {
  PLANNED_EDGE_TYPES,
  type EdgeDelta,
  type MindPlanEdge,
  type MindPlanGraph,
  type MindPlanNode,
  type NextSlot,
  type PlannedEdgeType,
  type Revision,
} from "../f-domain-model/types.js";

function blocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

/** Deduped and sorted by code unit, so a list sorts the same on every locale. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** A delta that changes nothing. */
export function emptyDelta(): EdgeDelta {
  return { add: [], remove: [] };
}

/** Live with the delta applied: removes first, then adds; sorted and deduped. */
export function applyDelta(live: string[] | undefined, d: EdgeDelta | undefined): string[] {
  const out = new Set(live ?? []);
  for (const entry of d?.remove ?? []) out.delete(entry);
  for (const entry of d?.add ?? []) out.add(entry);
  return sortedUnique(out);
}

/** The delta that turns live into `snapshot` (each side sorted and deduped). */
export function diffDelta(live: string[] | undefined, snapshot: string[] | undefined): EdgeDelta {
  const from = new Set(live ?? []);
  const to = new Set(snapshot ?? []);
  return {
    add: sortedUnique([...to].filter((v) => !from.has(v))),
    remove: sortedUnique([...from].filter((v) => !to.has(v))),
  };
}

/** Change ids of a node's open revisions, sorted. */
export function openChanges(node: MindPlanNode): string[] {
  return sortedUnique((node.open_revisions ?? []).map((r) => r.change));
}

/** The node's open revision of `change`, if any. */
export function revisionFor(node: MindPlanNode, change: string): Revision | undefined {
  return node.open_revisions?.find((r) => r.change === change);
}

function quoted(values: string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

/**
 * Which open revision a call on `node` means: `change` when given (Blocked when the node has no
 * revision of it), else the only open revision, else `null` (live) when none is open. Several
 * open and no `change` is Blocked, naming them.
 */
export function resolveRevisionChange(node: MindPlanNode, change?: string): string | null {
  const open = openChanges(node);
  if (change !== undefined) {
    if (open.includes(change)) return change;
    throw blocked(
      open.length
        ? `"${node.id}" has no open revision of change "${change}"; open revisions: ${quoted(open)}.`
        : `"${node.id}" has no open revision of change "${change}"; it has no open revision.`
    );
  }
  if (open.length === 0) return null;
  if (open.length === 1) return open[0];
  throw blocked(`"${node.id}" has open revisions ${quoted(open)}; pass change.`);
}

/**
 * Which open revision a call on `node` means, and the node as that call sees it: `change` when the
 * node has a revision of it, else (omitted) the node's only open revision. `view` is
 * `withRevision(node, change)`, or the node itself when `change` is null (live). With `strict`, a
 * `change` the node has no revision of, or several open and none named, is Blocked as
 * `resolveRevisionChange` Blocks; without it both read live (`change: null`).
 */
export function pickRevision(
  node: MindPlanNode,
  change: string | undefined,
  opts: { strict: boolean }
): { change: string | null; view: MindPlanNode } {
  let picked: string | null;
  if (opts.strict) picked = resolveRevisionChange(node, change);
  else if (change !== undefined) picked = revisionFor(node, change) ? change : null;
  else {
    const open = openChanges(node);
    picked = open.length === 1 ? open[0] : null;
  }
  return { change: picked, view: picked === null ? node : withRevision(node, picked) };
}

/**
 * A new node object for live plus the revision of `change`: `next` is that revision materialised
 * as a `NextSlot` (edges and claims = live with the delta applied, decisions = live then the
 * revision's), `tests` is live with the test delta applied, and every other field stays live.
 * The input is never mutated; a node with no revision of `change` is returned as is.
 */
export function withRevision(node: MindPlanNode, change: string): MindPlanNode {
  const rev = revisionFor(node, change);
  if (!rev) return node;
  const next: NextSlot = {
    state: rev.state,
    title: rev.title,
    description: rev.description,
    updated_at: rev.updated_at,
    opened_at: rev.opened_at,
    change: rev.change,
  };
  for (const type of PLANNED_EDGE_TYPES) next[type] = applyDelta(node[type], rev.edges[type]);
  next.implements = applyDelta(node.implements, rev.implements);
  if (rev.role) next.role = rev.role;
  if (rev.change_ref) next.change_ref = rev.change_ref;
  next.decisions = [...(node.decisions ?? []), ...(rev.decisions ?? [])];
  if (rev.attributed?.length) next.attributed = [...rev.attributed];
  // The revision stores the parts it declares; its view carries live's record plus those.
  if (rev.split_into?.length) next.split_into = [...new Set([...(node.split_into ?? []), ...rev.split_into])];
  return { ...node, next, tests: applyDelta(node.tests, rev.tests) };
}

function edgeKey(e: MindPlanEdge): string {
  return `${e.source}:${e.type}:${e.target}`;
}

/**
 * The graph a revision of `change` is judged against: every node with a revision of `change`
 * replaced by `withRevision`, every other node live (other changes' revisions are invisible).
 * `edges` keeps every edge of the input except the outgoing planned-type edges of those nodes,
 * which are rebuilt from their `next` view the way the loader (`discoverEdges`) builds them from
 * live fields, then sorted the same way. The input is never mutated.
 */
export function graphUnder(graph: MindPlanGraph, change: string): MindPlanGraph {
  const revised = new Set<string>();
  const nodes = graph.nodes.map((n) => {
    if (!revisionFor(n, change)) return n;
    revised.add(n.id);
    return withRevision(n, change);
  });
  if (revised.size === 0) return { ...graph, nodes, edges: [...graph.edges] };
  const planned = new Set<string>(PLANNED_EDGE_TYPES);
  const edges = graph.edges.filter((e) => !(revised.has(e.source) && planned.has(e.type)));
  for (const n of nodes) {
    if (!revised.has(n.id) || !n.next) continue;
    for (const type of PLANNED_EDGE_TYPES) {
      for (const target of n.next[type as PlannedEdgeType] ?? []) edges.push({ source: n.id, target, type });
    }
  }
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return { ...graph, nodes, edges };
}

/**
 * Whether a marked part counts when `node`'s open revision ships, by the edge that keeps imports
 * legal: a Foundation depends_on its parts (it stays the composition root), an Interaction shares
 * a Capability with them (the behavior moved to sibling actions), an Interface exposes them.
 */
export function splitPartLinked(graph: MindPlanGraph, node: MindPlanNode, partId: string): boolean {
  const next = node.next;
  if (!next) return false;
  if (node.type === "Foundation") return (next.depends_on ?? []).includes(partId);
  if (node.type === "Interface") return (next.exposes ?? []).includes(partId);
  const part = graph.nodes.find((n) => n.id === partId);
  // The revision's own Capabilities, as its ship will write them.
  const capabilities = new Set(next.belongs_to ?? []);
  return (part?.next?.belongs_to ?? part?.belongs_to ?? []).some((j) => capabilities.has(j));
}

/**
 * The parts a revision split out of its node (`node` is the view of that revision, `withRevision`):
 * the ids its next slot marks in `split_into` beyond the live list, kept only where the edge that
 * keeps imports legal is in place (`splitPartLinked`). The dry-run walk and the real ship
 * (`shipRevision`) both record exactly these. A split is declared, not guessed.
 */
export function splitParts(graph: MindPlanGraph, node: MindPlanNode): string[] {
  if (!node.next) return [];
  const live = new Set(node.split_into ?? []);
  return (node.next.split_into ?? []).filter((id) => !live.has(id) && splitPartLinked(graph, node, id)).sort();
}
