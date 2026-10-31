/**
 * Assess a change's impact — owned by i-assess-impact: get_blast_radius for a node or a whole
 * change (members, planned edges, additivity).
 */

import { type MindPlanGraph } from "../../foundations/f-domain-model/types.js";
import { loadGraph } from "../../foundations/f-territory-store/store.js";
import { changeAdditivity } from "../../foundations/f-compiler-rules/open-closed.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import { changeMembership, plannedEdges } from "../../foundations/f-compiler-rules/planned.js";
import { nodeDecisions } from "../../foundations/f-graph-search/decisions.js";
import {
  BlastRadiusDecision,
  DependentDecisionsSummary,
  VIA_ORDER,
  buildBlastRadiusPayload,
} from "../../foundations/f-plan-views/views.js";

export function getBlastRadius(args: {
  node_id?: string;
  change?: string;
  include_retired?: boolean;
  include_dependent_decisions?: boolean;
}): Record<string, unknown> {
  if ((args.node_id === undefined) === (args.change === undefined)) {
    throw blocked('get_blast_radius takes exactly one of "node_id" or "change".');
  }
  const graph = loadGraph();
  if (args.change !== undefined) {
    return buildChangeBlastRadiusPayload(graph, args.change, {
      include_retired: args.include_retired,
      include_dependent_decisions: args.include_dependent_decisions,
    });
  }
  const node = findNode(graph, args.node_id!);
  return buildBlastRadiusPayload(graph, node, {
    include_retired: args.include_retired,
    include_dependent_decisions: args.include_dependent_decisions,
  });
}

/**
 * Blast radius of a whole change: the radii of its members (open revisions and the shipped nodes
 * with planned edges under it) merged. `affected` keeps each node's smallest distance and
 * leaves out the members themselves; files group by owner.
 */
export function buildChangeBlastRadiusPayload(
  graph: MindPlanGraph,
  change: string,
  opts: { include_retired?: boolean; include_dependent_decisions?: boolean } = {}
): Record<string, unknown> {
  // A shipped node with planned wiring under the change is a member too: its contract will change.
  const { revisions, planned } = changeMembership(graph, change);
  const plannedIds = new Set(planned.map((n) => n.id));
  const members = [...revisions, ...planned];
  if (members.length === 0) {
    throw blocked(
      `change "${change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
    );
  }
  const memberIds = new Set(members.map((m) => m.id));
  const affected = new Map<string, { id: string; type: string; state: string; distance: number }>();
  const journeys = new Set<string>();
  const files = new Map<string, { owner_id: string; owner_type: string; via: Set<string>; files: Set<string> }>();
  const rulesReach = new Map<string, unknown>();
  const decisions = new Map<string, BlastRadiusDecision>();
  const dependentHolders = new Map<string, { count: number; distance: number }>();
  const tests = new Set<string>();
  for (const member of members) {
    const one = buildBlastRadiusPayload(graph, member, opts);
    for (const row of one.affected as { id: string; type: string; state: string; distance: number }[]) {
      if (memberIds.has(row.id)) continue;
      const prev = affected.get(row.id);
      if (!prev || row.distance < prev.distance) affected.set(row.id, row);
    }
    for (const j of one.journeys_at_risk as string[]) journeys.add(j);
    for (const group of one.affected_files as {
      owner_id: string;
      owner_type: string;
      via: string[];
      files: string[];
    }[]) {
      let merged = files.get(group.owner_id);
      if (!merged) {
        merged = { owner_id: group.owner_id, owner_type: group.owner_type, via: new Set(), files: new Set() };
        files.set(group.owner_id, merged);
      }
      for (const v of group.via) merged.via.add(v);
      for (const f of group.files) merged.files.add(f);
    }
    for (const t of one.tests as string[]) tests.add(t);
    rulesReach.set(member.id, one.rules_impact);
    // Each holder that is not a member counts once, at its smallest distance from any member.
    const distances = new Map(
      (one.affected as { id: string; distance: number }[]).map((row) => [row.id, row.distance])
    );
    const counts = new Map<string, number>();
    for (const row of one.decisions as BlastRadiusDecision[]) {
      if (row.via === "dependent") counts.set(row.node_id, (counts.get(row.node_id) ?? 0) + 1);
    }
    for (const id of (one.dependent_decisions as DependentDecisionsSummary).nodes) {
      if (memberIds.has(id)) continue;
      const distance = distances.get(id) ?? Number.MAX_SAFE_INTEGER;
      const prev = dependentHolders.get(id);
      const count = counts.get(id) ?? prev?.count ?? nodeDecisions(graph, findNode(graph, id)).length;
      if (!prev || distance < prev.distance) dependentHolders.set(id, { count, distance });
    }
    for (const row of one.decisions as BlastRadiusDecision[]) {
      // A member's own decisions are "focus"; otherwise keep the smallest distance.
      const asFocus = memberIds.has(row.node_id) ? { ...row, via: "focus" as const, distance: 0 } : row;
      const prev = decisions.get(row.id);
      if (!prev || asFocus.distance < prev.distance) decisions.set(row.id, asFocus);
    }
  }
  return {
    change,
    additivity: changeAdditivity(graph, change, { revisions, planned }),
    members: members.map((m) => ({
      id: m.id,
      type: m.type,
      kind: plannedIds.has(m.id) ? "planned" : "revision",
      state: m.state,
      next_state: m.next?.state ?? null,
    })),
    planned_edges: plannedEdges(graph, change).map(({ source, type, target }) => ({ source, type, target })),
    affected: [...affected.values()].sort(
      (a, b) => a.distance - b.distance || a.id.localeCompare(b.id)
    ),
    journeys_at_risk: [...journeys].sort(),
    affected_files: [...files.values()]
      .map((g) => ({
        owner_id: g.owner_id,
        owner_type: g.owner_type,
        via: VIA_ORDER.filter((v) => g.via.has(v)),
        files: [...g.files].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.owner_id.localeCompare(b.owner_id)),
    tests: [...tests].sort((a, b) => a.localeCompare(b)),
    rules_impact: Object.fromEntries(rulesReach),
    decisions: [...decisions.values()].sort(
      (a, b) => a.distance - b.distance || a.node_id.localeCompare(b.node_id)
    ),
    dependent_decisions: {
      count: [...dependentHolders.values()].reduce((sum, h) => sum + h.count, 0),
      nodes: [...dependentHolders.entries()]
        .sort((a, b) => a[1].distance - b[1].distance || a[0].localeCompare(b[0]))
        .map(([id]) => id),
    },
  };
}
