/**
 * Fan-in signal — owned by f-fan-in. Before a Foundation ships, hotspot detection has no ship
 * history to read, so a Foundation every feature depends on (one database layer serving every
 * Interaction) looks fine until the next feature has to reopen it. This module counts a pre-ship
 * Foundation's direct dependents, groups them by the Capability they belong to (the grouping that
 * suggests a per-area split), and words the `fan-in:` warning. Only a split that brings the count
 * down, or a `keep_whole` decision held by the node, clears it: a decision about anything else
 * does not. Graph facts only, and only ever a warning.
 */

import { isInactiveNode, type MindPlanGraph, type MindPlanNode } from "../f-domain-model/types.js";
import type { FanInSettings } from "../f-source-index/config.js";
import { fanIn, fanInIndex, keepsWhole, supersededIds, type FanInIndex } from "../f-compiler-rules/open-closed.js";

/** One group of dependents: a Capability (`capability` its id), or a node type outside any Capability. */
export type FanInGroup = { capability: string | null; label: string; count: number };

export type FanInGrouping = {
  /** Direct fan-in as `stability.fan_in` counts it (one glob claim's dependents count once). */
  count: number;
  /** How many groups are Capabilities. */
  capabilities: number;
  /** Largest group first, then by label. */
  groups: FanInGroup[];
};

export type FanInSignal = FanInGrouping & { node_id: string; role?: string; threshold: number };

/** Precomputed once per check: the fan-in index, nodes by id, and the superseded decision ids. */
export type FanInContext = { index: FanInIndex; byId: Map<string, MindPlanNode>; superseded: Set<string> };

export function fanInContext(graph: MindPlanGraph): FanInContext {
  return {
    index: fanInIndex(graph),
    byId: new Map(graph.nodes.map((n) => [n.id, n])),
    superseded: supersededIds(graph),
  };
}

/** A Foundation that has never shipped and is not retired. */
export function isPreShipFoundation(node: MindPlanNode): boolean {
  return node.type === "Foundation" && !node.shipped_at && !isInactiveNode(node);
}

const TYPE_LABEL: Record<string, string> = { Foundation: "Foundations", Interface: "Interfaces", Interaction: "Interactions" };

/**
 * The node's direct dependents grouped by Capability: an Interaction counts once in each active
 * Capability it `belongs_to`; any other dependent (a Foundation, an Interface, an Interaction in no
 * Capability) counts in a group named by its type.
 */
export function fanInGrouping(graph: MindPlanGraph, node: MindPlanNode, ctx: FanInContext = fanInContext(graph)): FanInGrouping {
  const fan = fanIn(graph, node, ctx.index);
  const capsOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "belongs_to") continue;
    const cap = ctx.byId.get(e.target);
    if (!cap || cap.type !== "Capability" || isInactiveNode(cap)) continue;
    capsOf.set(e.source, [...(capsOf.get(e.source) ?? []), cap.id]);
  }
  const groups = new Map<string, FanInGroup>();
  const bump = (key: string, capability: string | null, label: string) => {
    const g = groups.get(key) ?? { capability, label, count: 0 };
    g.count++;
    groups.set(key, g);
  };
  for (const id of fan.nodes) {
    const dep = ctx.byId.get(id);
    if (!dep) continue;
    const caps = dep.type === "Interaction" ? [...new Set(capsOf.get(id) ?? [])] : [];
    if (caps.length === 0) {
      bump(`type:${dep.type}`, null, TYPE_LABEL[dep.type] ?? dep.type);
      continue;
    }
    for (const cap of caps) bump(`cap:${cap}`, cap, ctx.byId.get(cap)?.title ?? cap);
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { count: fan.count, capabilities: sorted.filter((g) => g.capability).length, groups: sorted };
}

/**
 * The warning case: a pre-ship Foundation whose role is not exempt (`settings.exempt_roles`), whose
 * direct fan-in exceeds `threshold` (config `decisions.blast_radius`), and that holds no active
 * `keep_whole` decision of its own. A decision on another node that lists it, or any decision
 * without `keep_whole`, leaves the warning in place.
 */
export function fanInFor(
  graph: MindPlanGraph,
  node: MindPlanNode,
  settings: FanInSettings,
  threshold: number,
  ctx: FanInContext = fanInContext(graph)
): FanInSignal | null {
  if (!isPreShipFoundation(node)) return null;
  if (node.role && settings.exempt_roles.includes(node.role)) return null;
  if ((ctx.index.get(node.id)?.size ?? 0) <= threshold) return null;
  const grouping = fanInGrouping(graph, node, ctx);
  if (grouping.count <= threshold || keepsWhole(node, ctx.superseded)) return null;
  return { node_id: node.id, ...(node.role ? { role: node.role } : {}), threshold, ...grouping };
}

/** Every fan-in warning case, highest count first, then by id. */
export function fanInSignals(graph: MindPlanGraph, settings: FanInSettings, threshold: number): FanInSignal[] {
  const ctx = fanInContext(graph);
  return graph.nodes
    .map((n) => fanInFor(graph, n, settings, threshold, ctx))
    .filter((s): s is FanInSignal => s !== null)
    .sort((a, b) => b.count - a.count || a.node_id.localeCompare(b.node_id));
}

/** The `fan-in:` warning line (the check prefixes `Warning: `). */
export function fanInWarning(s: FanInSignal): string {
  const role = s.role ? ` (${s.role})` : "";
  const groups = s.groups.map((g) => `${g.label} ${g.count}`).join(", ");
  const across =
    s.capabilities > 0
      ? ` across ${s.capabilities} ${s.capabilities === 1 ? "Capability" : "Capabilities"} (${groups})`
      : ` (${groups})`;
  const areas = s.capabilities > 0 ? "these areas" : "this graph";
  return (
    `fan-in: "${s.node_id}"${role} has ${s.count} dependents${across}, more than the blast_radius setting of ${s.threshold}. ` +
    `Every new feature in ${areas} will depend on it. Split it into one Foundation per area that depends on a smaller core, ` +
    `or record_decision({ node_id: "${s.node_id}", keep_whole: true, why }) if it should stay whole.`
  );
}
