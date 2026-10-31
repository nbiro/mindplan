/**
 * Fan-out signal — owned by f-fan-out. A planned node that depends on nodes in many other unbuilt
 * changes may have to know every feature of a kind (erasing a site has to clean up after billing,
 * analytics, teams, …), so every new feature would edit its plan too. Each edge is correct on its
 * own; only the count says the design should be inverted onto a Foundation contract. Graph facts
 * only, and only ever a warning.
 */

import {
  activeChange,
  isInactiveNode,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
} from "../f-domain-model/types.js";
import type { FanOutSettings } from "../f-source-index/config.js";
import { keepsWhole } from "../f-compiler-rules/open-closed.js";

export type FanOutCount = { count: number; changes: string[] };

export type FanOut = FanOutCount & { node_id: string };

/** A Foundation, Interaction, or Interface that has never shipped and is not retired. */
function isPreShipPipelineNode(node: MindPlanNode): boolean {
  return isPipelineNodeType(node.type) && !node.shipped_at && !isInactiveNode(node);
}

/**
 * The distinct other unshipped changes `node` reaches through `depends_on`, in the order their
 * first target appears; null unless the node is a pre-ship Foundation, Interaction, or Interface.
 * A target counts when it exists, is not retired, has never shipped, and carries a change id that
 * differs from the node's own. Shipped targets are settled substrate, and same-change targets are
 * one feature.
 */
export function fanOut(graph: MindPlanGraph, node: MindPlanNode, byId?: Map<string, MindPlanNode>): FanOutCount | null {
  if (!isPreShipPipelineNode(node)) return null;
  const nodes = byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
  const own = activeChange(node);
  const changes: string[] = [];
  for (const id of node.depends_on ?? []) {
    const target = nodes.get(id);
    if (!target || isInactiveNode(target) || target.shipped_at) continue;
    const change = activeChange(target);
    if (!change || change === own || changes.includes(change)) continue;
    changes.push(change);
  }
  return { count: changes.length, changes };
}

/** Ids of every decision some active record supersedes, so a superseded `keep_whole` no longer counts. */
function supersededIds(graph: MindPlanGraph): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (isInactiveNode(n)) continue;
    for (const d of [...(n.decisions ?? []), ...(n.next?.decisions ?? [])]) if (d.supersedes) ids.add(d.supersedes);
  }
  return ids;
}

/** Precomputed once per check: the nodes by id and the superseded decision ids. */
export type FanOutContext = { byId: Map<string, MindPlanNode>; superseded: Set<string> };

export function fanOutContext(graph: MindPlanGraph): FanOutContext {
  return { byId: new Map(graph.nodes.map((n) => [n.id, n])), superseded: supersededIds(graph) };
}

/**
 * The warning case: the node reaches at least `warn_at` other unshipped changes and holds no
 * active `keep_whole` decision (the same switch the hotspot signal honours).
 */
export function fanOutFor(
  graph: MindPlanGraph,
  node: MindPlanNode,
  settings: FanOutSettings,
  ctx: FanOutContext = fanOutContext(graph)
): FanOut | null {
  const f = fanOut(graph, node, ctx.byId);
  if (!f || f.count < settings.warn_at || keepsWhole(node, ctx.superseded)) return null;
  return { node_id: node.id, ...f };
}

/** Every fan-out warning case, highest count first, then by id. */
export function fanOuts(graph: MindPlanGraph, settings: FanOutSettings): FanOut[] {
  const ctx = fanOutContext(graph);
  return graph.nodes
    .map((n) => fanOutFor(graph, n, settings, ctx))
    .filter((f): f is FanOut => f !== null)
    .sort((a, b) => b.count - a.count || a.node_id.localeCompare(b.node_id));
}

/** The `fan-out:` warning line (the check prefixes `Warning: `). */
export function fanOutWarning(f: FanOut): string {
  return (
    `fan-out: ${f.node_id} depends on ${f.count} other changes (${f.changes.join(", ")}). ` +
    "It may need to know every feature of a kind. Consider inverting: put a contract on a Foundation " +
    "those changes meet (a schema convention, or a record they react to), enforce it with a node rule " +
    "and a test, and drop these depends_on edges."
  );
}
