/**
 * Cycles across changes: the depends_on graph over live plus every open change at once. Each gate
 * judges one change (`revisionGraph`), so two changes can each add half of a cycle and both pass;
 * neither could then ship after the other. This module finds such cycles and Blocks the edge that
 * would close one.
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

/** Strongly connected components with more than one node (Tarjan), as node id sets. */
function cyclicComponents(adj: Map<string, string[]>): Set<string>[] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: Set<string>[] = [];
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
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
  };
  for (const v of [...adj.keys()].sort()) if (!idx.has(v)) visit(v);
  return out;
}

const MAX_CYCLES = 500;

/** Elementary cycles inside one component, each as a node path (first node not repeated). */
function elementaryCycles(adj: Map<string, string[]>, comp: Set<string>): string[][] {
  const order = [...comp].sort();
  const out: string[][] = [];
  for (let i = 0; i < order.length && out.length < MAX_CYCLES; i++) {
    const start = order[i];
    const allowed = new Set(order.slice(i));
    const path = [start];
    const onPath = new Set([start]);
    const walk = (v: string): void => {
      for (const w of adj.get(v) ?? []) {
        if (out.length >= MAX_CYCLES) return;
        if (w === start) out.push([...path]);
        else if (allowed.has(w) && !onPath.has(w)) {
          path.push(w);
          onPath.add(w);
          walk(w);
          path.pop();
          onPath.delete(w);
        }
      }
    };
    walk(start);
  }
  return out;
}

/**
 * The cycle as changes must ship it: each edge takes live when it is live, else a change chosen
 * greedily to cover as many edges as possible. Null when one change (or live alone) closes it,
 * which the per-change acyclic check owns, or when a chosen change removes a live edge it uses.
 */
function classify(path: string[], t: EdgeTags): ChangeCycle | null {
  const pairs = path.map((s, i) => [s, path[(i + 1) % path.length]] as const);
  const needed = pairs.map(([s, d]) => t.tags.get(key(s, d)) ?? new Set<string | null>());
  const open = needed.map((tags, i) => (tags.has(null) ? -1 : i)).filter((i) => i >= 0);
  if (open.length === 0) return null;
  const common = [...needed[open[0]]].filter((c) => open.every((i) => needed[i].has(c)));
  if (common.length > 0) return null;
  const chosen = new Map<number, string>();
  while (chosen.size < open.length) {
    const count = new Map<string, number>();
    for (const i of open) {
      if (chosen.has(i)) continue;
      for (const c of needed[i]) if (c !== null) count.set(c, (count.get(c) ?? 0) + 1);
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    for (const i of open) if (!chosen.has(i) && needed[i].has(best)) chosen.set(i, best);
  }
  const changes = [...new Set(chosen.values())].sort();
  for (let i = 0; i < pairs.length; i++) {
    if (chosen.has(i)) continue;
    const gone = t.removed.get(key(pairs[i][0], pairs[i][1]));
    if (gone && changes.some((c) => gone.has(c))) return null;
  }
  const edges = pairs.map(([source, target], i) => ({ source, target, change: chosen.get(i) ?? null }));
  return { changes, path: [...path, path[0]], edges };
}

function allCycles(graph: MindPlanGraph, extra?: ProposedDependsOn): ChangeCycle[] {
  const t = taggedEdges(graph, extra);
  const adj = new Map<string, string[]>();
  for (const k of t.tags.keys()) {
    const [s, d] = k.split("\u0000");
    adj.set(s, [...(adj.get(s) ?? []), d]);
    if (!adj.has(d)) adj.set(d, []);
  }
  for (const list of adj.values()) list.sort();
  const out: ChangeCycle[] = [];
  for (const comp of cyclicComponents(adj)) {
    for (const path of elementaryCycles(adj, comp)) {
      const cycle = classify(path, t);
      if (cycle) out.push(cycle);
    }
  }
  return out;
}

/**
 * Every depends_on cycle over live plus every open change whose edges come from two or more
 * changes (each such set of changes could never ship in any order), one per node set.
 */
export function changeCycles(graph: MindPlanGraph): ChangeCycle[] {
  const seen = new Set<string>();
  const out: ChangeCycle[] = [];
  for (const cycle of allCycles(graph)) {
    const k = [...new Set(cycle.path)].sort().join("\u0000");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cycle);
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
 * Blocked when the depends_on edge `source -> target` (under `change`, or live) would close, or
 * already closes, a dependency cycle whose edges come from two or more changes.
 */
export function assertNoChangeCycle(graph: MindPlanGraph, edge: ProposedDependsOn): void {
  for (const cycle of allCycles(graph, edge)) {
    const at = cycle.edges.findIndex((e) => e.source === edge.source && e.target === edge.target);
    if (at < 0) continue;
    const nodes = cycle.path.slice(0, -1);
    const path = [...nodes.slice(at), ...nodes.slice(0, at), edge.source];
    const label = edge.change ? `change "${edge.change}"` : "live";
    throw blocked(
      `depends_on "${edge.source}" -> "${edge.target}" (${label}) would close a dependency cycle across changes ` +
        `${cycle.changes.map((c) => `"${c}"`).join(", ")}: ${path.join(" -> ")}. ${REMEDY}`
    );
  }
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
