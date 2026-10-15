/**
 * Node-rules inheritance over the live graph — pure queries, no file I/O.
 * Rules flow up `belongs_to`, along transitive `depends_on`, and from affected nodes into Bugs.
 * Nothing flows downward, across siblings, or through `exposes` / `leads_to`.
 * Inactive nodes (retired, or Bugs that are resolved/wontfix) neither give nor receive rules.
 */

import {
  isInactiveNode,
  type MindPlanGraph,
  type MindPlanNode,
  type RuleEntry,
  type RuleVia,
  type RulesImpactEntry,
} from "../f-domain-model/types.js";

const VIA_RANK: Record<RuleVia, number> = { self: 0, belongs_to: 1, depends_on: 2, affects: 3 };

type NodeIndex = Map<string, MindPlanNode>;

function indexNodes(graph: MindPlanGraph): NodeIndex {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/** Breadth-first closure over one live edge field; distance 1 is a direct edge. Skips `start`. */
function closure(
  byId: NodeIndex,
  start: MindPlanNode,
  field: "belongs_to" | "depends_on"
): { node: MindPlanNode; distance: number }[] {
  const seen = new Set<string>([start.id]);
  const out: { node: MindPlanNode; distance: number }[] = [];
  let frontier = [start];
  for (let distance = 1; frontier.length > 0; distance++) {
    const next: MindPlanNode[] = [];
    for (const node of frontier) {
      for (const targetId of node[field] ?? []) {
        const target = byId.get(targetId);
        if (!target || seen.has(targetId)) continue;
        seen.add(targetId);
        out.push({ node: target, distance });
        next.push(target);
      }
    }
    frontier = next;
  }
  return out;
}

function entry(node: MindPlanNode, via: RuleVia, distance: number): RuleEntry | null {
  if (!node.rules) return null;
  return { node_id: node.id, node_type: node.type, via, distance, rules: node.rules };
}

/** Own rules plus `belongs_to` and transitive `depends_on` rules of one node. */
function baseEntries(byId: NodeIndex, node: MindPlanNode): RuleEntry[] {
  const out: RuleEntry[] = [];
  const own = entry(node, "self", 0);
  if (own) out.push(own);
  for (const field of ["belongs_to", "depends_on"] as const) {
    for (const { node: reached, distance } of closure(byId, node, field)) {
      if (isInactiveNode(reached)) continue;
      const e = entry(reached, field, distance);
      if (e) out.push(e);
    }
  }
  return out;
}

function resolveIn(byId: NodeIndex, focus: MindPlanNode): RuleEntry[] {
  const collected = baseEntries(byId, focus);
  if (focus.type === "Bug") {
    for (const targetId of focus.affects ?? []) {
      const target = byId.get(targetId);
      if (!target || isInactiveNode(target)) continue;
      for (const e of baseEntries(byId, target)) {
        collected.push({ ...e, via: "affects", distance: e.distance + 1 });
      }
    }
  }

  const best = new Map<string, RuleEntry>();
  for (const e of collected) {
    const prior = best.get(e.node_id);
    if (!prior || e.distance < prior.distance) best.set(e.node_id, e);
  }
  return [...best.values()].sort(
    (a, b) =>
      VIA_RANK[a.via] - VIA_RANK[b.via] ||
      a.distance - b.distance ||
      a.node_id.localeCompare(b.node_id)
  );
}

/**
 * The rules that apply to `nodeId`, each labeled with the node it came from.
 * Order: self, `belongs_to`, `depends_on`, `affects`; then ascending distance, then node id.
 * A node reached twice keeps its smallest distance. Empty-rules and inactive nodes are omitted.
 */
export function resolveNodeRules(graph: MindPlanGraph, nodeId: string): RuleEntry[] {
  const byId = indexNodes(graph);
  const focus = byId.get(nodeId);
  return focus ? resolveIn(byId, focus) : [];
}

/**
 * The other active nodes whose resolved rules include an entry from `nodeId` — the exact inverse
 * of `resolveNodeRules`. Empty when `nodeId` has no rules.
 */
export function rulesAudience(graph: MindPlanGraph, nodeId: string): RulesImpactEntry[] {
  const byId = indexNodes(graph);
  const source = byId.get(nodeId);
  if (!source?.rules) return [];
  const out: RulesImpactEntry[] = [];
  for (const node of graph.nodes) {
    if (node.id === nodeId || isInactiveNode(node)) continue;
    const hit = resolveIn(byId, node).find((e) => e.node_id === nodeId);
    if (hit) {
      out.push({ id: node.id, type: node.type, state: node.state, via: hit.via, distance: hit.distance });
    }
  }
  return out.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}

/** The `rules_impact` payload: whether the node carries rules and whose work they reach. */
export function rulesImpact(
  graph: MindPlanGraph,
  node: MindPlanNode
): { has_rules: boolean; inherited_by: RulesImpactEntry[] } {
  return { has_rules: Boolean(node.rules), inherited_by: rulesAudience(graph, node.id) };
}
