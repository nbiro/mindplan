/**
 * Revise a shipped node — owned by i-revise-node: open_next (one open revision per change, with
 * planned edges and the hotspot warning), discard_next, and resolve_conflict.
 */

import { type MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  entityRelativePath,
  loadGraph,
  loadProjectConfig,
  removeLegacyMirror,
  validateChangeInput,
} from "../../foundations/f-territory-store/store.js";
import {
  discardRevision,
  openRevision,
  rebaseRevisionOntoLive,
  resolveConflict as resolveRevisionConflict,
  revisionRelativeFilePath,
} from "../../foundations/f-territory-store/revisions.js";
import { openChanges, resolveRevisionChange } from "../../foundations/f-revision-model/index.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import { openClosedWarning } from "../../foundations/f-compiler-rules/open-closed.js";
import { blocked, findNode, validateOpenNext } from "../../foundations/f-compiler-rules/rules.js";
import { plannedEdgeProblems } from "../../foundations/f-compiler-rules/planned.js";
import { assertNoChangeCycle } from "../../foundations/f-compiler-rules/change-cycles.js";
import { orientationGateEnabled, rulesFingerprint } from "../../foundations/f-orientation-ledger/ledger.js";
import {
  assertNoLegacyNext,
  changedFiles,
  conflictLabel,
  gateWrite,
  mutationTail,
  refreshPersistedMap,
  rulesReachingAfterWrite,
  territoryPath,
  withChangeCleanup,
} from "../../foundations/f-plan-writes/writes.js";

export function openNext(args: {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  change?: string;
  change_ref?: string;
}): Record<string, unknown> {
  const { node_id, title, description } = args;
  const change = args.change || undefined;
  if (!change) {
    throw blocked(
      `open_next needs change: every revision of a shipped node belongs to one change id (a slug, e.g. "add-export"). ` +
        `Retry with open_next({ node_id: "${node_id}", change: "<change-id>" }).`
    );
  }
  gateWrite(null, [node_id], "open_next");
  validateChangeInput(args);
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  assertNoLegacyNext(node, "open_next");
  validateOpenNext(node, change);
  // Reopening a widely depended-on node warns now, while an additive design is still cheap.
  const openClosed = openClosedWarning(graph, node, hotspotSettings(loadProjectConfig()));
  // A planned depends_on that closes a cycle with another change's edges could never ship.
  for (const e of node.planned ?? []) {
    if (e.change === change && e.type === "depends_on") assertNoChangeCycle(graph, { source: node_id, target: e.target, change });
  }
  // The revision takes its change's planned edges: each must still be legal before it opens.
  const problems = plannedEdgeProblems(graph, change).filter((p) => p.startsWith(`planned edge ${node_id} -`));
  if (problems.length > 0) {
    throw blocked(
      `open_next would apply planned edges that are no longer legal: ${problems.join("; ")}. ` +
        `Remove each with unlink_nodes({ source_id: "${node_id}", target_id, change: "${change}" }), then retry.`
    );
  }
  const planned = (node.planned ?? []).filter((e) => e.change === change);
  const applied = planned
    .filter((e) => !(node[e.type] ?? []).includes(e.target))
    .map((e) => `${node_id} -${e.type}-> ${e.target}`);
  const rulesBefore = orientationGateEnabled() ? rulesFingerprint(graph, node_id) : null;
  // A leftover mirror file from before 0.8.0 is not a revision: opening one removes it.
  const removedMirror = removeLegacyMirror(node);
  const opened = openRevision(node, change, {
    change_ref: args.change_ref,
    title,
    description,
    plannedAdds: planned,
  });
  refreshPersistedMap();
  const rel = entityRelativePath(node);
  const revisionPath = revisionRelativeFilePath(node, change);
  const { revision } = opened;
  return {
    node_id,
    live_state: node.state,
    change,
    revision: {
      change,
      state: revision.state,
      title: revision.title,
      description: revision.description,
      opened_at: revision.opened_at,
      ...(revision.change_ref ? { change_ref: revision.change_ref } : {}),
    },
    folder: rel,
    current: territoryPath(node, "current"),
    revision_path: revisionPath,
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
              change,
            },
          },
        }
      : {}),
    // Applied belongs_to / depends_on can bring new rules: return them so the node stays oriented.
    ...(applied.length ? rulesReachingAfterWrite(node_id, rulesBefore) : {}),
    changed_files: changedFiles([...opened.changed_files, ...removedMirror]),
    // `revisions` lists every open revision of the node: this one and its siblings.
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function discardNext(args: { node_id: string; change?: string; verbose?: boolean }): Record<string, unknown> {
  // Discarding a change's last revision closes it: its planned edges go with it.
  return withChangeCleanup(() => discardRevisionWrite(args));
}

function discardRevisionWrite(args: { node_id: string; change?: string; verbose?: boolean }): Record<string, unknown> {
  const { node_id } = args;
  gateWrite(null, [node_id], "discard_next");
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  assertNoLegacyNext(node, "discard_next");
  const change = resolveRevisionChange(node, args.change || undefined);
  if (change === null) {
    throw blocked(
      `node "${node_id}" has no open revision to discard (a leftover mirror file is not a revision; upgrade_project removes it).`
    );
  }
  const removed = discardRevision(node, change);
  refreshPersistedMap();
  return {
    node_id,
    change,
    discarded: true,
    live_state: node.state,
    changed_files: changedFiles(removed.changed_files),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export type ResolveConflictArgs = {
  node_id: string;
  change?: string;
  section?: string;
  field?: "title" | "description" | "role";
  claim?: string;
  take: "revision" | "live" | "text";
  text?: string;
  verbose?: boolean;
};

/** A section target as stored on the conflict: `"## Heading"` (a bare heading gets the `## `). */
function sectionTarget(section: string): string {
  const trimmed = section.trim();
  return trimmed.startsWith("#") ? trimmed : `## ${trimmed}`;
}

export function resolveConflict(args: ResolveConflictArgs): Record<string, unknown> {
  const { node_id, take } = args;
  const targets = [args.section, args.field, args.claim].filter((t) => t !== undefined && t !== "");
  if (targets.length !== 1) {
    throw blocked("resolve_conflict takes exactly one of section, field, or claim (the conflict to resolve).");
  }
  if (take === "text" && args.text === undefined) {
    throw blocked('take "text" needs text: the value to write in place of both sides.');
  }
  gateWrite(null, [node_id], "resolve_conflict");
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const change = resolveRevisionChange(node, args.change || undefined);
  if (change === null) throw blocked(`node "${node_id}" has no open revision, so it holds no conflict.`);
  const target = args.section !== undefined && args.section !== "" ? sectionTarget(args.section) : (args.field ?? args.claim)!;
  const out = resolveRevisionConflict(node, change, target, take, args.text);
  refreshPersistedMap();
  return {
    node_id,
    change,
    resolved: target,
    take,
    conflicts: out.conflicts.map(conflictLabel),
    changed_files: changedFiles(out.changed_files),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

/**
 * rebase_revision: carries one open revision onto current live (live moved since it opened: a
 * sibling shipped on another branch and the branches merged, or live was patched in place), with
 * the rule a ship applies to its siblings. A revision whose base already matches live is a no-op.
 */
export function rebaseRevision(args: { node_id: string; change?: string; verbose?: boolean }): Record<string, unknown> {
  const { node_id } = args;
  gateWrite(null, [node_id], "rebase_revision");
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  assertNoLegacyNext(node, "rebase_revision");
  const change = resolveRevisionChange(node, args.change || undefined);
  if (change === null) throw blocked(`node "${node_id}" has no open revision to rebase.`);
  const out = rebaseRevisionOntoLive(graph, node, change);
  if (out.rebased) refreshPersistedMap();
  return {
    node_id,
    change,
    rebased: out.rebased,
    conflicts: out.conflicts.map(conflictLabel),
    ...(out.readiness_reset ? { readiness_reset: out.readiness_reset } : {}),
    changed_files: changedFiles(out.changed_files),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
