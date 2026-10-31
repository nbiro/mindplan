/**
 * Plan views — the read payloads several read actions share: a node's blast radius (dependents,
 * affected files by owner, tests, rules impact, decisions) and the rules version tag. Owned by
 * f-plan-views.
 */

import { createHash } from "crypto";
import {
  isInactiveNode,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
} from "../../foundations/f-domain-model/types.js";
import { projectRoot, summarizeGraphNode } from "../../foundations/f-territory-store/store.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import { listResolvedImports } from "../../foundations/f-source-index/imports.js";
import { RETIRED_STATES } from "../../foundations/f-source-index/ownership.js";
import { blastRadiusDependents, interactionReachability, interfacesExposing } from "../../foundations/f-compiler-rules/rules.js";
import { rulesImpact } from "../../foundations/f-graph-search/rules.js";
import { nodeDecisions, supersessionIndex } from "../../foundations/f-graph-search/decisions.js";

export type AffectedFileVia = "focus" | "dependent" | "exposing" | "importer";

export const VIA_ORDER: AffectedFileVia[] = ["focus", "dependent", "exposing", "importer"];

export function isRetired(node: MindPlanNode): boolean {
  return RETIRED_STATES.has(node.state);
}

/** Reverse-depends_on blast radius; Interaction focus also includes reachability + affected_files. */
export function buildBlastRadiusPayload(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: { include_retired?: boolean; include_dependent_decisions?: boolean } = {}
): Record<string, unknown> {
  const includeRetired = opts.include_retired === true;
  const { affected: entries } = blastRadiusDependents(graph, node.id);
  const visibleEntries = includeRetired
    ? entries
    : entries.filter(({ node: n }) => !isRetired(n));

  const journeysAtRisk = new Set<string>();
  for (const { node: affected } of visibleEntries) {
    if (affected.type !== "Interaction") continue;
    for (const edge of graph.edges) {
      if (edge.source === affected.id && edge.type === "belongs_to") {
        journeysAtRisk.add(edge.target);
      }
    }
  }

  const root = projectRoot();
  type Group = {
    owner_id: string;
    owner_type: string;
    via: Set<AffectedFileVia>;
    files: Set<string>;
  };
  const groups = new Map<string, Group>();
  // The linked tests of every owner listed below: the suites a change to the focus should run.
  const tests = new Set<string>();

  const pushFiles = (owner: MindPlanNode, via: AffectedFileVia) => {
    if (!includeRetired && isRetired(owner)) return;
    for (const p of expandClaims(owner.tests, root)) tests.add(p);
    let group = groups.get(owner.id);
    if (!group) {
      group = {
        owner_id: owner.id,
        owner_type: owner.type,
        via: new Set(),
        files: new Set(),
      };
      groups.set(owner.id, group);
    }
    group.via.add(via);
    for (const p of expandClaims(owner.implements, root)) {
      group.files.add(p);
    }
    if (owner.next) {
      for (const p of expandClaims(owner.next.implements, root)) {
        group.files.add(p);
      }
    }
    // Files the revision adds in another node's folder count as the revision's own.
    if (via === "focus") {
      for (const p of (owner.next ? owner.next.attributed : owner.attributed) ?? []) group.files.add(p);
    }
  };

  if (isPipelineNodeType(node.type)) {
    pushFiles(node, "focus");
  }
  // Walk all BFS entries (including retired) so importers/dependents behind them stay visible;
  // pushFiles skips retired owners unless include_retired.
  for (const { node: dep } of entries) {
    if (isPipelineNodeType(dep.type)) pushFiles(dep, "dependent");
  }

  if (node.type === "Interaction") {
    for (const iface of interfacesExposing(graph, node.id)) {
      pushFiles(iface, "exposing");
    }
  }

  // Importers: other nodes whose files import focus-owned files
  const focusFiles = new Set([
    ...expandClaims(node.implements, root),
    ...(node.next ? expandClaims(node.next.implements, root) : []),
  ]);
  if (focusFiles.size > 0) {
    for (const other of graph.nodes) {
      if (other.id === node.id || !isPipelineNodeType(other.type)) continue;
      const otherFiles = [
        ...expandClaims(other.implements, root),
        ...(other.next ? expandClaims(other.next.implements, root) : []),
      ];
      let importsFocus = false;
      for (const f of otherFiles) {
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
        for (const edge of listResolvedImports(f, root)) {
          if (focusFiles.has(edge.to)) {
            importsFocus = true;
            break;
          }
        }
        if (importsFocus) break;
      }
      if (importsFocus) pushFiles(other, "importer");
    }
  }

  const affected_files = [...groups.values()]
    .map((g) => ({
      owner_id: g.owner_id,
      owner_type: g.owner_type,
      via: VIA_ORDER.filter((v) => g.via.has(v)),
      files: [...g.files].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.owner_id.localeCompare(b.owner_id));

  const payload: Record<string, unknown> = {
    node_id: node.id,
    affected: visibleEntries.map(({ node: n, distance }) => ({
      id: n.id,
      type: n.type,
      state: n.state,
      distance,
    })),
    journeys_at_risk: [...journeysAtRisk].sort(),
    affected_files,
    tests: [...tests].sort((a, b) => a.localeCompare(b)),
    rules_impact: rulesImpact(graph, node),
    ...blastRadiusDecisions(graph, node, visibleEntries, opts.include_dependent_decisions === true),
  };
  if (node.type === "Interaction") {
    const reach = interactionReachability(graph, node.id);
    const keep = (n: MindPlanNode) => includeRetired || !isRetired(n);
    payload.reachability = {
      exposing_interfaces: reach.exposing_interfaces
        .filter(keep)
        .map(summarizeGraphNode),
      containing_journeys: reach.containing_journeys
        .filter(keep)
        .map(summarizeGraphNode),
      leads_to_downstream: reach.leads_to_downstream
        .filter(({ node: n }) => keep(n))
        .map(({ node: n, distance }) => ({
          ...summarizeGraphNode(n),
          distance,
        })),
    };
  }
  return payload;
}

/** One active decision a change to the focus would reach. */
export type BlastRadiusDecision = {
  id: string;
  node_id: string;
  via: "focus" | "dependent";
  distance: number;
  decision: string;
};

/** How many active decisions the dependents hold, and on which nodes (nearest first). */
export type DependentDecisionsSummary = { count: number; nodes: string[] };

/**
 * Active decisions held by the focus (`focus`, 0), plus `dependent_decisions` (the count and holding
 * nodes of every visible dependent's). The dependents' own rows (`dependent`) join `decisions` only
 * with `includeDependents`: the summary says whose reasoning a change reaches, the rows on request.
 */
export function blastRadiusDecisions(
  graph: MindPlanGraph,
  focus: MindPlanNode,
  dependents: { node: MindPlanNode; distance: number }[],
  includeDependents: boolean
): { decisions: BlastRadiusDecision[]; dependent_decisions: DependentDecisionsSummary } {
  const index = supersessionIndex(graph);
  const rows: BlastRadiusDecision[] = [];
  const summary: DependentDecisionsSummary = { count: 0, nodes: [] };
  const push = (n: MindPlanNode, via: "focus" | "dependent", distance: number) => {
    // A retired node's decisions constrain no live code, even when include_retired shows the node.
    if (isInactiveNode(n)) return;
    const held = nodeDecisions(graph, n, {}, index);
    if (via === "dependent" && held.length > 0) {
      summary.count += held.length;
      summary.nodes.push(n.id);
      if (!includeDependents) return;
    }
    for (const d of held) {
      rows.push({ id: d.id, node_id: n.id, via, distance, decision: d.decision });
    }
  };
  push(focus, "focus", 0);
  for (const { node: n, distance } of dependents) push(n, "dependent", distance);
  return { decisions: rows, dependent_decisions: summary };
}

/**
 * Short tag of a rules text (12 hex chars of its SHA-256): equal tags mean equal text, so a caller
 * that already holds the text can skip it.
 */
export function rulesVersion(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}
