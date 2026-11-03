/**
 * Cycles across changes: the depends_on graph over live plus every open change at once. Each gate
 * judges one change (`revisionGraph`), so two changes can each add half of a cycle and both pass;
 * neither could then ship after the other. This module finds such cycles (one search per
 * strongly connected component for run_check) and Blocks the edge that would close one (one search
 * from the edge's target back to its source).
 */

import type { MindPlanGraph } from "../f-domain-model/types.js";
import { isInactiveNode, isPipelineNodeType } from "../f-domain-model/types.js";
import { revisionFor } from "../f-revision-model/index.js";
import { plannedEdges } from "./planned.js";
import { blocked } from "./rules.js";

/** One depends_on edge of a cross-change cycle; `change` is null for a live edge. */
export type ChangeCycleEdge = { source: string; target: string; change: string | null };

/** A depends_on cycle whose edges come from two or more changes. */
export type ChangeCycle = { changes: string[]; path: string[]; edges: ChangeCycleEdge[] };

/** A proposed depends_on edge; no `change` means a live edge. */
export type ProposedDependsOn = { source: string; target: string; change?: string | null };

type EdgeTags = {
  /** `source\u0000target` → the changes that add the edge (null: live). */
  tags: Map<string, Set<string | null>>;
  /** `source\u0000target` → the changes whose revision removes that live edge. */
  removed: Map<string, Set<string>>;
};

const key = (source: string, target: string): string => `${source}\u0000${target}`;

function addTag(m: EdgeTags["tags"], source: string, target: string, change: string | null): void {
  const k = key(source, target);
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(change);
}

/**
 * Every depends_on edge of live and every open change, tagged by the change that adds it: a
 * shipped node's live edges (null), each open revision's add delta (its change; its remove delta
 * is recorded), a legacy next's additions (its change), a pre-ship node's edges (its change), and
 * every pending planned depends_on (its change).
 */
function taggedEdges(graph: MindPlanGraph, extra?: ProposedDependsOn): EdgeTags {
  const tags: EdgeTags["tags"] = new Map();
  const removed: EdgeTags["removed"] = new Map();
  for (const n of graph.nodes) {
    if (!isPipelineNodeType(n.type) || isInactiveNode(n)) continue;
    if (!n.shipped_at) {
      for (const t of n.depends_on ?? []) addTag(tags, n.id, t, n.change || null);
      continue;
    }
    for (const t of n.depends_on ?? []) addTag(tags, n.id, t, null);
    for (const r of n.open_revisions ?? []) {
      const d = r.edges.depends_on;
      for (const t of d?.add ?? []) addTag(tags, n.id, t, r.change);
      for (const t of d?.remove ?? []) {
        const k = key(n.id, t);
        let s = removed.get(k);
        if (!s) removed.set(k, (s = new Set()));
        s.add(r.change);
      }
    }
    const legacy = n.next && !(n.next.change && revisionFor(n, n.next.change)) ? n.next : undefined;
    if (legacy) {
      const live = new Set(n.depends_on ?? []);
      for (const t of legacy.depends_on ?? []) if (!live.has(t)) addTag(tags, n.id, t, legacy.change || null);
    }
  }
  for (const row of plannedEdges(graph)) {
    if (row.type === "depends_on") addTag(tags, row.source, row.target, row.change);
  }
  if (extra) addTag(tags, extra.source, extra.target, extra.change ?? null);
  return { tags, removed };
}

/** The overlay: every tagged depends_on edge, with sorted adjacency. Built once per graph. */
type Overlay = EdgeTags & { adj: Map<string, string[]> };

function buildOverlay(graph: MindPlanGraph): Overlay {
  const t = taggedEdges(graph);
  const adj = new Map<string, string[]>();
  for (const k of t.tags.keys()) {
    const [s, d] = k.split("\u0000");
    let list = adj.get(s);
    if (!list) adj.set(s, (list = []));
    list.push(d);
    if (!adj.has(d)) adj.set(d, []);
  }
  for (const list of adj.values()) list.sort();
  return { ...t, adj };
}

/** Strongly connected components with more than one node (iterative Tarjan), as node id sets. */
function cyclicComponents(adj: Map<string, string[]>): Set<string>[] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: Set<string>[] = [];
  for (const root of [...adj.keys()].sort()) {
    if (idx.has(root)) continue;
    // Each frame: a node and the position of the next neighbour to look at.
    const frames: { v: string; i: number }[] = [{ v: root, i: 0 }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const next = adj.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        }
        continue;
      }
      frames.pop();
      const v = frame.v;
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = new Set<string>();
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.add(w);
        } while (w !== v);
        if (comp.size > 1) out.push(comp);
      }
    }
  }
  return out;
}

/** The non-live changes that add `source -> target`, sorted. */
function changesOf(ov: Overlay, source: string, target: string): string[] {
  return [...(ov.tags.get(key(source, target)) ?? [])].filter((c): c is string => c !== null).sort();
}

/** A walk found by `crossWalk`: nodes from its start to its end, and the change each edge was taken under (null: live). */
type Walk = { nodes: string[]; labels: (string | null)[] };

/**
 * One breadth-first search from `from` to `to` over the overlay (O(V+E): each node is visited at
 * most twice, before and after the walk mixes changes). The walk carries a change label: it starts
 * as `start` (null: none yet, the first non-live edge picks one), an edge live and not removed by
 * that change or added by it keeps the label, and any other edge marks the walk as crossing into
 * another change. Returns the first walk that reaches `to` crossing, or null. `within` limits the
 * search to a node set; `budget` caps the states explored (shared across calls).
 */
function crossWalk(
  ov: Overlay,
  from: string,
  to: string,
  start: string | null,
  within?: Set<string>,
  budget?: { left: number }
): Walk | null {
  type State = { node: string; label: string | null; cross: boolean; parent: number; edge: string | null };
  const states: State[] = [{ node: from, label: start, cross: false, parent: -1, edge: null }];
  const seenPlain = new Set<string>([from]);
  const seenCross = new Set<string>();
  for (let head = 0; head < states.length; head++) {
    if (budget && budget.left-- <= 0) return null;
    const cur = states[head];
    for (const w of ov.adj.get(cur.node) ?? []) {
      if (within && !within.has(w)) continue;
      const k = key(cur.node, w);
      const tags = ov.tags.get(k)!;
      const live = tags.has(null);
      const removed = cur.label !== null && (ov.removed.get(k)?.has(cur.label) ?? false);
      const added = changesOf(ov, cur.node, w);
      let label = cur.label;
      let cross = cur.cross;
      let edge: string | null;
      if (live && !removed) edge = null;
      else if (label !== null && tags.has(label)) edge = label;
      else if (added.length === 0) continue; // a live edge this walk's change removes
      else if (label === null && !cross) {
        label = added[0];
        edge = label;
      } else {
        edge = added[0];
        cross = true;
      }
      const seen = cross ? seenCross : seenPlain;
      if (seen.has(w)) continue;
      seen.add(w);
      states.push({ node: w, label, cross, parent: head, edge });
      if (w === to && cross) {
        const nodes: string[] = [];
        const labels: (string | null)[] = [];
        for (let i = states.length - 1; i >= 0; i = states[i].parent) {
          nodes.unshift(states[i].node);
          if (states[i].parent >= 0) labels.unshift(states[i].edge);
        }
        return { nodes, labels };
      }
    }
  }
  return null;
}

/**
 * The cycle `nodes` (first node not repeated; edge i runs from nodes[i] to the next) as changes
 * must ship it, from each edge's label (null: live). Null unless its non-live edges span two or
 * more changes with no single change adding them all (one change, or live alone, is the
 * per-change acyclic check's), or when an involved change removes a live edge it uses.
 */
function classify(ov: Overlay, nodes: string[], labels: (string | null)[]): ChangeCycle | null {
  const pairs = nodes.map((s, i) => [s, nodes[(i + 1) % nodes.length]] as const);
  const changes = [...new Set(labels.filter((c): c is string => c !== null))].sort();
  if (changes.length < 2) return null;
  let common: Set<string> | null = null;
  pairs.forEach(([s, d], i) => {
    if (labels[i] === null) return;
    const added = new Set(changesOf(ov, s, d));
    if (labels[i] !== null) added.add(labels[i]!);
    common = common === null ? added : new Set([...common].filter((c) => added.has(c)));
  });
  if (common !== null && (common as Set<string>).size > 0) return null;
  for (let i = 0; i < pairs.length; i++) {
    if (labels[i] !== null) continue;
    const gone = ov.removed.get(key(pairs[i][0], pairs[i][1]));
    if (gone && changes.some((c) => gone.has(c))) return null;
  }
  const edges = pairs.map(([source, target], i) => ({ source, target, change: labels[i] }));
  return { changes, path: [...nodes, nodes[0]], edges };
}

/** States one SCC's search may explore before run_check gives up on it. */
const SCC_BUDGET = 200_000;

/**
 * Depends_on cycles over live plus every open change whose edges come from two or more changes
 * (each such set of changes could never ship in any order): at most one per strongly connected
 * component holding edges of two or more changes, found by a breadth-first search inside it from
 * each of its change edges in turn, under an exploration cap.
 */
export function changeCycles(graph: MindPlanGraph): ChangeCycle[] {
  const ov = buildOverlay(graph);
  const out: ChangeCycle[] = [];
  for (const comp of cyclicComponents(ov.adj)) {
    const changeEdges: [string, string][] = [];
    const changes = new Set<string>();
    for (const s of [...comp].sort()) {
      for (const d of ov.adj.get(s) ?? []) {
        if (!comp.has(d)) continue;
        const added = changesOf(ov, s, d);
        if (added.length === 0) continue;
        changeEdges.push([s, d]);
        for (const c of added) changes.add(c);
      }
    }
    if (changes.size < 2) continue;
    const budget = { left: SCC_BUDGET };
    search: for (const [s, d] of changeEdges) {
      for (const c of changesOf(ov, s, d)) {
        if (budget.left <= 0) break search;
        const walk = crossWalk(ov, d, s, c, comp, budget);
        if (!walk) continue;
        // The walk runs d … s; the closing edge s -> d is taken under c.
        const cycle = classify(ov, [s, ...walk.nodes.slice(0, -1)], [c, ...walk.labels]);
        if (cycle) {
          out.push(cycle);
          break search;
        }
      }
    }
  }
  return out;
}

const REMEDY = "The changes could never ship in any order; move the shared part into a Foundation both depend on.";

/** `a -> b -> a (a -> b in "x", b -> a in "y")`: the path and where each change's edge sits. */
export function describeChangeCycle(cycle: ChangeCycle): string {
  const by = cycle.edges.filter((e) => e.change !== null).map((e) => `${e.source} -> ${e.target} in "${e.change}"`);
  return (
    `changes ${cycle.changes.map((c) => `"${c}"`).join(", ")}: ${cycle.path.join(" -> ")} (${by.join(", ")}). ` + REMEDY
  );
}

/**
 * A gate over one overlay of `graph` (built once): Blocked when the depends_on edge
 * `source -> target` (under `change`, or live) would close, or already closes, a dependency cycle
 * whose edges come from two or more changes. Each call is one search from the edge's target back
 * to its source. open_next asserts every planned edge it applies through one gate.
 */
export function changeCycleGate(graph: MindPlanGraph): (edge: ProposedDependsOn) => void {
  const ov = buildOverlay(graph);
  return (edge) => {
    if (edge.source === edge.target) return;
    const change = edge.change ?? null;
    const walk = crossWalk(ov, edge.target, edge.source, change);
    if (!walk) return;
    const nodes = [edge.source, ...walk.nodes.slice(0, -1)];
    // The proposed edge counts as added by its change even before it is written.
    const k = key(edge.source, edge.target);
    const had = ov.tags.get(k);
    const tags = new Set(had ?? []);
    tags.add(change);
    ov.tags.set(k, tags);
    const cycle = classify(ov, nodes, [change, ...walk.labels]);
    if (had) ov.tags.set(k, had);
    else ov.tags.delete(k);
    if (!cycle) return;
    const label = edge.change ? `change "${edge.change}"` : "live";
    throw blocked(
      `depends_on "${edge.source}" -> "${edge.target}" (${label}) would close a dependency cycle across changes ` +
        `${cycle.changes.map((c) => `"${c}"`).join(", ")}: ${cycle.path.join(" -> ")}. ${REMEDY}`
    );
  };
}

/** One-off `changeCycleGate(graph)(edge)`. */
export function assertNoChangeCycle(graph: MindPlanGraph, edge: ProposedDependsOn): void {
  changeCycleGate(graph)(edge);
}

/**
 * The check's lines for cross-change cycles: `Blocked: change cycle: …` for each one, or with
 * `change` only those that change takes part in.
 */
export function changeCycleFailures(graph: MindPlanGraph, change?: string): string[] {
  return changeCycles(graph)
    .filter((c) => change === undefined || c.changes.includes(change))
    .map((c) => `Blocked: change cycle: ${describeChangeCycle(c)}`);
}
