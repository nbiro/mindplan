/**
 * Revise a shipped node — owned by i-revise-node: open_next (with planned edges and the hotspot
 * warning) and discard_next.
 */

import { type MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  NEXT_ATTACHMENTS_DIR,
  addEdgeToFrontmatter,
  discardNextSlot,
  entityRelativePath,
  loadGraph,
  loadProjectConfig,
  openNextSlot,
  validateChangeInput,
  writeChangeFrontmatter,
} from "../../foundations/f-territory-store/store.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import { openClosedWarning } from "../../foundations/f-compiler-rules/open-closed.js";
import { blocked, findNode, validateOpenNext } from "../../foundations/f-compiler-rules/rules.js";
import { plannedEdgeProblems } from "../../foundations/f-compiler-rules/planned.js";
import { orientationGateEnabled, rulesFingerprint } from "../../foundations/f-orientation-ledger/ledger.js";
import {
  changedFiles,
  gateWrite,
  mutationTail,
  refreshPersistedMap,
  rulesReachingAfterWrite,
  territoryPath,
  withNeighborCleanup,
} from "../../foundations/f-plan-writes/writes.js";

/**
 * After open_next: add the planned edges of the revision's change to the next slot (skipping any
 * already there). They stay on live until the revision ships, so a discard leaves them planned.
 */
function applyPlannedEdges(node: MindPlanNode): string[] {
  const change = node.next?.change;
  if (!change || !node.next) return [];
  const applied: string[] = [];
  for (const e of node.planned ?? []) {
    if (e.change !== change) continue;
    const current = node.next[e.type] ?? [];
    if (current.includes(e.target)) continue;
    addEdgeToFrontmatter(node, e.type, e.target);
    node.next[e.type] = [...current, e.target];
    applied.push(`${node.id} -${e.type}-> ${e.target}`);
  }
  return applied;
}

export function openNext(args: {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  change?: string;
  change_ref?: string;
}): Record<string, unknown> {
  gateWrite(null, [args.node_id], "open_next");
  const { node_id, title, description } = args;
  validateChangeInput(args);
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  validateOpenNext(node);
  // Reopening a widely depended-on node warns now, while an additive design is still cheap.
  const openClosed = openClosedWarning(graph, node, hotspotSettings(loadProjectConfig()));
  // The revision takes its change's planned edges: each must still be legal before it opens.
  const revisionChange = args.change !== undefined ? args.change || undefined : node.change;
  if (revisionChange) {
    const problems = plannedEdgeProblems(graph, revisionChange).filter((p) =>
      p.startsWith(`planned edge ${node_id} -`)
    );
    if (problems.length > 0) {
      throw blocked(
        `open_next would apply planned edges that are no longer legal: ${problems.join("; ")}. ` +
          `Remove each with unlink_nodes({ source_id: "${node_id}", target_id, change: "${revisionChange}" }), then retry.`
      );
    }
  }
  const next = openNextSlot(node, { title, description });
  node.next = next;
  // The next slot is a copy of live, so it inherits a neighbor label unless change says otherwise.
  if (args.change === undefined && node.change) next.change = node.change;
  // A live neighbor label that differs from the revision's change is stale: the node is now a
  // revision, not a neighbor. The store clears it so discard_next does not restore it.
  const replacedChange = writeChangeFrontmatter(
    node,
    { change: args.change, change_ref: args.change_ref },
    "next"
  );
  const rulesBefore = orientationGateEnabled() ? rulesFingerprint(graph, node_id) : null;
  const applied = applyPlannedEdges(node);
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const next_path = territoryPath(node, "next");
  refreshPersistedMap();
  return {
    node_id,
    live_state: node.state,
    next,
    folder: rel,
    current,
    next_path,
    ...(replacedChange ? { replaced_change: replacedChange } : {}),
    ...(applied.length ? { applied_planned: applied } : {}),
    ...(openClosed
      ? {
          warnings: [openClosed],
          decision_prompt: {
            tool: "record_decision",
            args: {
              node_id,
              decision: "<one sentence: why this revision reopens the node>",
              alternatives: [
                `A new node that depends_on "${node_id}" and adds the behavior without revising it: <why it lost>`,
              ],
              why: "<the constraint that makes revising it the right call>",
              ...(next.change ? { change: next.change } : {}),
            },
          },
        }
      : {}),
    // Applied belongs_to / depends_on can bring new rules: return them so the node stays oriented.
    ...(applied.length ? rulesReachingAfterWrite(node_id, rulesBefore) : {}),
    changed_files: changedFiles(
      [next_path, `${rel}/${NEXT_ATTACHMENTS_DIR}/.gitkeep`, replacedChange ? current : null],
      true
    ),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function discardNext(args: { node_id: string; verbose?: boolean }): Record<string, unknown> {
  // Discarding a change's last revision closes it. The live label left after the discard can only
  // name the revision's own change (the store drops any other), so that closing clears it too.
  return withNeighborCleanup(() => discardNextSlotWrite(args));
}

function discardNextSlotWrite(args: { node_id: string; verbose?: boolean }): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  if (!node.next) {
    throw blocked(
      `node "${node_id}" has no open evolution to discard (a leftover mirror file is not a revision; mindplan-mcp init removes it).`
    );
  }
  const removed = discardNextSlot(node);
  delete node.next;
  refreshPersistedMap();
  return {
    node_id,
    discarded: true,
    live_state: node.state,
    changed_files: changedFiles(removed, true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
