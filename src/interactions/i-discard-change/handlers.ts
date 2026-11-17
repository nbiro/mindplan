/**
 * Discard a change — owned by i-discard-change: discard_change drops a whole unshipped change in one
 * call (its open revisions, its never-shipped nodes, and its planned edges), after checking that
 * nothing that stays points at what goes.
 */

import * as fs from "fs";
import * as path from "path";
import {
  EDGE_TYPES,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
} from "../../foundations/f-domain-model/types.js";
import { loadGraph, projectRoot, removeNode } from "../../foundations/f-territory-store/store.js";
import { discardRevision } from "../../foundations/f-territory-store/revisions.js";
import {
  assertNoShippedDependentsOnRevision,
  blocked,
  recomputeCapabilityStates,
  recomputeStability,
} from "../../foundations/f-compiler-rules/rules.js";
import { changeMembership } from "../../foundations/f-compiler-rules/planned.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import {
  changedFiles,
  clearClosedChanges,
  gateWrite,
  refreshPersistedMap,
  syncNodes,
} from "../../foundations/f-plan-writes/writes.js";

type Pointer = { source: string; type: string; target: string; where: string };

/**
 * Every edge from a node that stays to a node that goes: live edges, edge deltas in another
 * change's revision (or a legacy next file), and another change's planned entries.
 */
function pointersInto(graph: MindPlanGraph, going: Set<string>, change: string): Pointer[] {
  const out: Pointer[] = [];
  for (const n of graph.nodes) {
    if (going.has(n.id)) continue;
    const live = n as unknown as Record<string, string[] | undefined>;
    for (const type of EDGE_TYPES) {
      for (const target of live[type] ?? []) if (going.has(target)) out.push({ source: n.id, type, target, where: "live" });
    }
    if (n.next && !(n.open_revisions ?? []).length) {
      const next = n.next as unknown as Record<string, string[] | undefined>;
      for (const type of EDGE_TYPES) {
        for (const target of next[type] ?? []) {
          if (going.has(target) && !(live[type] ?? []).includes(target)) out.push({ source: n.id, type, target, where: "next" });
        }
      }
    }
    for (const rev of n.open_revisions ?? []) {
      if (rev.change === change) continue;
      for (const [type, delta] of Object.entries(rev.edges)) {
        for (const target of delta?.add ?? []) {
          if (going.has(target)) out.push({ source: n.id, type, target, where: `revision "${rev.change}"` });
        }
      }
    }
    for (const e of n.planned ?? []) {
      if (e.change !== change && going.has(e.target)) {
        out.push({ source: n.id, type: e.type, target: e.target, where: `planned "${e.change}"` });
      }
    }
  }
  return out;
}

function unlinkCall(p: Pointer): string {
  const quoted = p.where.match(/"([^"]+)"/)?.[1];
  const change = quoted ? `, change: "${quoted}"` : "";
  return `unlink_nodes({ source_id: "${p.source}", target_id: "${p.target}"${change} })`;
}

/**
 * discard_change({ change }): every open revision of the change, every never-shipped member, and
 * every planned edge under it, in that order (planned edges last: `clearClosedChanges` drops them
 * only once no member is left). Everything is checked before the first write.
 */
export function discardChange(args: { change: string }): Record<string, unknown> {
  const { change } = args;
  const graph = loadGraph();
  const { revisions, planned } = changeMembership(graph, change);
  const plannedOnShipped = graph.nodes.filter((n) => (n.planned ?? []).some((e) => e.change === change));
  if (revisions.length === 0 && planned.length === 0 && plannedOnShipped.length === 0) {
    throw blocked(`change "${change}" has no members (no open revision, never-shipped node, or planned edge): nothing to discard.`);
  }
  const memberIds = [...new Set([...revisions, ...planned, ...plannedOnShipped].map((n) => n.id))];
  gateWrite(graph, memberIds, "discard_change", { change });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const revised = revisions.filter((n) => n.shipped_at).map((n) => byId.get(n.id)!);
  const preShip = revisions.filter((n) => !n.shipped_at).map((n) => byId.get(n.id)!);
  const going = new Set(preShip.map((n) => n.id));

  const problems: string[] = [];
  for (const node of preShip) {
    if ((node.revisions ?? 0) > 0) {
      problems.push(
        `"${node.id}" shipped before (force_unship returned it; it keeps the decisions of its shipped life): ` +
          `cancel it with update_node_status({ node_id: "${node.id}", new_status: "cancelled" }), or clear its change id ` +
          `with patch_node_territory({ node_id: "${node.id}", change: "" }) so it leaves the change.`
      );
    }
  }
  for (const node of revised) {
    try {
      assertNoShippedDependentsOnRevision(graph, node, change);
    } catch (err) {
      problems.push((err instanceof Error ? err.message : String(err)).replace(/^Blocked: /, ""));
    }
  }
  for (const p of pointersInto(graph, going, change)) {
    problems.push(`"${p.source}" ${p.type} "${p.target}" (${p.where}) points at a node this discard removes: ${unlinkCall(p)}.`);
  }
  if (problems.length > 0) {
    throw blocked(`discard_change "${change}" wrote nothing: ${problems.join(" ")}`);
  }

  // Claimed files of what goes, read before it goes: they stay on disk, unclaimed.
  const revisionClaims = revised.flatMap((n) => (n.open_revisions ?? []).find((r) => r.change === change)?.implements.add ?? []);
  const claimed = new Set([...expandClaims(preShip.flatMap((n) => n.implements ?? [])), ...expandClaims(revisionClaims)]);

  // The planned entries that go, read before they go (the reply names them as edges).
  const plannedGoing = graph.nodes.flatMap((n) =>
    (n.planned ?? []).filter((e) => e.change === change).map((e) => ({ source_id: n.id, edge_type: e.type, target_id: e.target }))
  );
  // Decisions that go: each discarded revision's own, and every decision a removed node holds.
  const decisionCount =
    revised.reduce((n, node) => n + ((node.open_revisions ?? []).find((r) => r.change === change)?.decisions?.length ?? 0), 0) +
    preShip.reduce((n, node) => n + (node.decisions?.length ?? 0), 0);

  const files: string[] = [];
  for (const node of revised) files.push(...discardRevision(node, change).changed_files);
  for (const node of preShip) files.push(...removeNode(node));

  const after = loadGraph();
  const cleared = clearClosedChanges(after, [change]);
  files.push(...cleared.files);
  const capabilities = recomputeCapabilityStates(after);
  const stability = recomputeStability(after);
  files.push(...syncNodes([...capabilities, ...stability]));
  refreshPersistedMap();

  const finalGraph = loadGraph();
  const stillClaimed = new Set(expandClaims(finalGraph.nodes.filter((n) => isPipelineNodeType(n.type)).flatMap((n) => n.implements ?? [])));
  const root = projectRoot();
  const unclaimed = [...claimed].filter((f) => !stillClaimed.has(f) && fs.existsSync(path.join(root, f))).sort();
  const kept = finalGraph.nodes.flatMap((n) =>
    (n.decisions ?? []).filter((d) => d.change === change).map((d) => ({ id: d.id, node_id: n.id }))
  );

  return {
    change,
    discarded: {
      revisions: revised.map((n) => n.id),
      nodes: preShip.map((n) => n.id),
      planned: plannedGoing,
      decisions: decisionCount,
    },
    ...(kept.length > 0
      ? {
          kept_decisions: kept,
          kept_note: "Decisions beside a live file stay: a ship leaves the same change tag. Supersede one that no longer holds with record_decision.",
        }
      : {}),
    ...(unclaimed.length > 0
      ? { unclaimed_files: unclaimed, unclaimed_note: "These files stay on disk unclaimed; run_check reports Blocked: Coverage until each is deleted or claimed." }
      : {}),
    changed_files: changedFiles(files, true),
  };
}
