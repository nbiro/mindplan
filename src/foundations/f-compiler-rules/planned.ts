/**
 * Planned edges: wiring a shipped node will gain when a change opens it. They live on the node's
 * live file (`planned`), outside `graph.edges`, so no rule treats them as real until `open_next`
 * applies them. This module lists the pending ones and checks each the way `link_nodes` would.
 */

import type {
  MindPlanGraph,
  MindPlanNode,
  PlannedEdge,
  PlannedEdgeType,
} from "../f-domain-model/types.js";
import { activeChange, isInactiveNode, isPipelineNodeType } from "../f-domain-model/types.js";
import { assertAcyclicDependsOn, blocked, changeMembers, validateLink } from "./rules.js";

/** One pending planned edge, with its source. */
export type PlannedEdgeRow = { source: string; change: string; type: PlannedEdgeType; target: string };

/**
 * Pending planned edges (of one change, or all): every live entry of a shipped, active node,
 * except the entries a revision of their change has already applied — those are in its next slot
 * now. An entry of that change the next slot lacks (the revision took the change id after it
 * opened) stays pending, so it is still listed and checked.
 */
export function plannedEdges(graph: MindPlanGraph, change?: string): PlannedEdgeRow[] {
  const rows: PlannedEdgeRow[] = [];
  for (const n of graph.nodes) {
    if (!n.planned?.length || !n.shipped_at || isInactiveNode(n)) continue;
    const open = n.next ? activeChange(n) : undefined;
    for (const e of n.planned) {
      if (change !== undefined && e.change !== change) continue;
      if (open !== undefined && e.change === open && (n.next?.[e.type] ?? []).includes(e.target)) continue;
      rows.push({ source: n.id, change: e.change, type: e.type, target: e.target });
    }
  }
  return rows.sort(
    (a, b) => a.source.localeCompare(b.source) || a.type.localeCompare(b.type) || a.target.localeCompare(b.target)
  );
}

/** Shipped nodes with pending planned edges under `change`: its members of kind `planned`. */
export function changePlannedSources(graph: MindPlanGraph, change: string): MindPlanNode[] {
  const ids = new Set(plannedEdges(graph, change).map((r) => r.source));
  return graph.nodes.filter((n) => ids.has(n.id));
}

/**
 * Every member of a change, each once: its open revisions and the shipped nodes with pending
 * planned edges under it (a node already listed as a revision keeps that kind). The check, the
 * change blast radius, and change-wide orientation share it.
 */
export function changeMembership(
  graph: MindPlanGraph,
  change: string
): { revisions: MindPlanNode[]; planned: MindPlanNode[] } {
  const revisions = changeMembers(graph, change);
  const listed = new Set(revisions.map((n) => n.id));
  const planned = changePlannedSources(graph, change).filter((n) => !listed.has(n.id));
  return { revisions, planned };
}

/**
 * The graph with a change's pending planned `depends_on` added to each source's effective
 * `depends_on` (live, and the open next when there is one), so a cycle check sees the wiring the
 * change will add.
 */
export function withPlannedDependsOn(graph: MindPlanGraph, change: string, extra?: PlannedEdgeRow): MindPlanGraph {
  const add = new Map<string, string[]>();
  for (const r of [...plannedEdges(graph, change), ...(extra ? [extra] : [])]) {
    if (r.type !== "depends_on") continue;
    add.set(r.source, [...(add.get(r.source) ?? []), r.target]);
  }
  if (add.size === 0) return graph;
  const union = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const targets = add.get(n.id);
      if (!targets) return n;
      return {
        ...n,
        depends_on: union(n.depends_on, targets),
        // An open next's depends_on replaces live (effectiveDependsOn): none listed means none.
        ...(n.next ? { next: { ...n.next, depends_on: union(n.next.depends_on, targets) } } : {}),
      };
    }),
  };
}

function liveTargets(node: MindPlanNode, type: PlannedEdgeType): string[] {
  return node[type] ?? [];
}

/**
 * Why one planned edge is illegal, or null: the source must be a shipped, active pipeline node;
 * the target must exist and be active; `validateLink` must accept the shape; the edge must not
 * already be live; a `depends_on` must close no cycle with the change's other planned wiring.
 */
function plannedEdgeProblem(graph: MindPlanGraph, withPlanned: MindPlanGraph, row: PlannedEdgeRow): string | null {
  const source = graph.nodes.find((n) => n.id === row.source);
  if (!source || !isPipelineNodeType(source.type) || !source.shipped_at || isInactiveNode(source)) {
    return `"${row.source}" is not a shipped, active Foundation, Interaction, or Interface, so it cannot hold planned edges.`;
  }
  const target = graph.nodes.find((n) => n.id === row.target);
  if (!target) return `target "${row.target}" does not exist in mindplan territory.`;
  if (isInactiveNode(target)) return `target "${row.target}" is ${target.state}.`;
  try {
    validateLink(source, target, row.type);
    if (row.type === "depends_on") assertAcyclicDependsOn(withPlanned, row.source, row.target);
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).replace(/^Blocked: /, "");
  }
  if (liveTargets(source, row.type).includes(row.target)) {
    return `edge ${row.source} -${row.type}-> ${row.target} already exists on the live node.`;
  }
  return null;
}

/** One line per illegal pending planned edge of `change`: `<source> -<type>-> <target>: <why>`. */
export function plannedEdgeProblems(graph: MindPlanGraph, change: string): string[] {
  const withPlanned = withPlannedDependsOn(graph, change);
  const out: string[] = [];
  for (const row of plannedEdges(graph, change)) {
    const problem = plannedEdgeProblem(graph, withPlanned, row);
    if (problem) out.push(`planned edge ${row.source} -${row.type}-> ${row.target}: ${problem}`);
  }
  return out;
}

/** Blocked unless a new planned edge is legal and not already planned under its change. */
export function validatePlannedLink(graph: MindPlanGraph, row: PlannedEdgeRow): void {
  const source = graph.nodes.find((n) => n.id === row.source);
  const dup = source?.planned?.some(
    (e: PlannedEdge) => e.change === row.change && e.type === row.type && e.target === row.target
  );
  if (dup) {
    throw blocked(`edge ${row.source} -${row.type}-> ${row.target} is already planned under change "${row.change}".`);
  }
  const problem = plannedEdgeProblem(graph, withPlannedDependsOn(graph, row.change, row), row);
  if (problem) throw blocked(problem);
}
